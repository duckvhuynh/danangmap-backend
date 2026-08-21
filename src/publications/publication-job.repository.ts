import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { PublicationJobListQueryDto } from './publication.dto';

export interface PublicationJobRow {
  id: string;
  layerId: string;
  revisionId: string;
  status: 'queued' | 'building' | 'succeeded' | 'failed';
  phase: 'queued' | 'preparing' | 'scanning_features' | 'switching' | 'completed' | 'failed';
  lockVersion: number;
  featureTotal: number | null;
  featureProcessed: number;
  attempts: number;
  resultSnapshotId: string | null;
  resultGeneration: number | null;
  failureCode: string | null;
  failureCorrelationId: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  updatedAt: Date | string;
}

export interface PublicationAdmissionInput {
  layerId: string;
  revisionId: string;
  requestedBy: string;
  requestId: string;
  releaseNote: string;
  expectedActiveSnapshotId: string | null;
  expectedActiveGeneration: number | null;
  revisionLockVersion: number;
  revisionSchemaVersion: number;
  revisionFingerprint: string;
  maxAttempts: number;
}

interface PublicationCursor {
  createdAt: string;
  id: string;
}

export interface PublicationOutboxClaim {
  id: string;
  publicationJobId: string;
  payloadVersion: number;
  leaseToken: string;
  attempts: number;
}

@Injectable()
export class PublicationJobRepository {
  constructor(private readonly dataSource: DataSource) {}

  async insertAdmission(
    manager: EntityManager,
    input: PublicationAdmissionInput,
  ): Promise<PublicationJobRow> {
    const inserted = this.rows<{ id: string }>(
      await manager.query(
        `INSERT INTO publication_jobs(
           layer_id,revision_id,requested_by,request_id,client_intent,release_note,
           expected_active_snapshot_id,expected_active_generation,revision_lock_version,
           revision_schema_version,revision_fingerprint,status,phase,max_attempts
         ) VALUES($1,$2,$3,$4,'desktop',$5,$6,$7,$8,$9,$10,'queued','queued',$11)
         RETURNING id`,
        [
          input.layerId,
          input.revisionId,
          input.requestedBy,
          input.requestId,
          input.releaseNote,
          input.expectedActiveSnapshotId,
          input.expectedActiveGeneration,
          input.revisionLockVersion,
          input.revisionSchemaVersion,
          input.revisionFingerprint,
          input.maxAttempts,
        ],
      ),
    );
    const id = inserted[0]?.id;
    if (!id) throw new Error('Publication job insert returned no identifier.');
    await manager.query(
      `INSERT INTO publication_job_outbox(publication_job_id,payload_version,status)
       VALUES($1,1,'pending')`,
      [id],
    );
    const job = await this.findById(id, manager);
    if (!job) throw new Error('Publication job insert could not be read back.');
    return job;
  }

  async findById(id: string, manager: EntityManager = this.dataSource.manager) {
    const rows = this.rows<PublicationJobRow>(
      await manager.query(this.selectJobSql('job.id=$1'), [id]),
    );
    return rows[0] ?? null;
  }

  async listForLayer(
    layerId: string,
    query: PublicationJobListQueryDto,
    cursor: PublicationCursor | null,
  ): Promise<PublicationJobRow[]> {
    const values: unknown[] = [layerId];
    const where = ['job.layer_id=$1'];
    if (query.status) {
      values.push(query.status);
      where.push(`job.status=$${values.length}`);
    }
    if (query.revisionId) {
      values.push(query.revisionId);
      where.push(`job.revision_id=$${values.length}::uuid`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where.push(
        `(job.created_at,job.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(query.limit + 1);
    return this.rows<PublicationJobRow>(
      await this.dataSource.query(
        `${this.selectJobSql(where.join(' AND '))}
         ORDER BY job.created_at DESC,job.id DESC LIMIT $${values.length}`,
        values,
      ),
    );
  }

  async layerExists(layerId: string): Promise<boolean> {
    const rows = this.rows<Record<string, unknown>>(
      await this.dataSource.query(`SELECT 1 FROM layers WHERE id=$1`, [layerId]),
    );
    return rows.length > 0;
  }

  async activeForLayer(manager: EntityManager, layerId: string): Promise<{ id: string } | null> {
    const rows = this.rows<{ id: string }>(
      await manager.query(
        `SELECT id FROM publication_jobs
         WHERE layer_id=$1 AND status IN ('queued','building')
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [layerId],
      ),
    );
    return rows[0] ?? null;
  }

  async claimOutbox(
    limit: number,
    leaseOwner: string,
    leaseSeconds: number,
  ): Promise<PublicationOutboxClaim[]> {
    return this.dataSource.transaction(async (manager) =>
      this.rows<PublicationOutboxClaim>(
        await manager.query(
          `WITH due AS (
             SELECT id FROM publication_job_outbox
             WHERE (status='pending' AND available_at<=now())
                OR (status='dispatching' AND lease_expires_at<=now())
             ORDER BY available_at,id
             FOR UPDATE SKIP LOCKED
             LIMIT $1
           )
           UPDATE publication_job_outbox outbox
           SET status='dispatching',attempts=outbox.attempts+1,lease_token=gen_random_uuid(),
               lease_owner=$2,lease_expires_at=now()+($3::text || ' seconds')::interval,
               last_error_code=NULL
           FROM due WHERE outbox.id=due.id
           RETURNING outbox.id,outbox.publication_job_id AS "publicationJobId",
                     outbox.payload_version AS "payloadVersion",outbox.lease_token AS "leaseToken",
                     outbox.attempts`,
          [limit, leaseOwner, leaseSeconds],
        ),
      ),
    );
  }

  async markOutboxDispatched(id: string, leaseToken: string): Promise<boolean> {
    const rows = this.rows<Record<string, unknown>>(
      await this.dataSource.query(
        `UPDATE publication_job_outbox
         SET status='dispatched',dispatched_at=COALESCE(dispatched_at,now()),
             lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL
         WHERE id=$1 AND status='dispatching' AND lease_token=$2
         RETURNING 1`,
        [id, leaseToken],
      ),
    );
    return rows.length === 1;
  }

  async releaseOutboxClaim(
    id: string,
    leaseToken: string,
    delaySeconds: number,
    errorCode: string,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE publication_job_outbox
       SET status='pending',available_at=now()+($3::text || ' seconds')::interval,
           lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,last_error_code=$4
       WHERE id=$1 AND status='dispatching' AND lease_token=$2`,
      [id, leaseToken, delaySeconds, errorCode],
    );
  }

  async queuedForReconciliation(
    limit: number,
  ): Promise<Array<{ id: string; payloadVersion: number }>> {
    return this.dataSource.transaction(async (manager) => {
      const cursorRows = this.rows<{
        createdAt: Date | null;
        jobId: string | null;
      }>(
        await manager.query(
          `SELECT reconciliation_cursor_created_at AS "createdAt",
                  reconciliation_cursor_job_id AS "jobId"
           FROM publication_worker_state WHERE id=1 FOR UPDATE`,
        ),
      );
      const cursor = cursorRows[0];
      if (!cursor) throw new Error('Publication worker state is missing.');

      let jobs = await this.reconciliationPage(manager, limit, cursor.createdAt, cursor.jobId);
      if (jobs.length === 0 && cursor.createdAt && cursor.jobId) {
        jobs = await this.reconciliationPage(manager, limit, null, null);
      }
      const last = jobs.at(-1);
      if (last) {
        await manager.query(
          `UPDATE publication_worker_state
           SET reconciliation_cursor_created_at=$1,reconciliation_cursor_job_id=$2,updated_at=now()
           WHERE id=1`,
          [last.createdAt, last.id],
        );
      }
      return jobs.map(({ id, payloadVersion }) => ({ id, payloadVersion }));
    });
  }

  async updateDispatchState(errorCode: string | null): Promise<void> {
    await this.dataSource.query(
      `UPDATE publication_worker_state
       SET last_dispatch_sweep_at=now(),
           queue_depth=(SELECT count(*)::integer FROM publication_jobs WHERE status='queued'),
           oldest_queued_age_seconds=COALESCE((
             SELECT floor(extract(epoch FROM now()-min(created_at)))::integer
             FROM publication_jobs WHERE status='queued'
           ),0),
           building_count=(SELECT count(*)::integer FROM publication_jobs WHERE status='building'),
           last_error_code=$1,updated_at=now()
       WHERE id=1`,
      [errorCode],
    );
  }

  private selectJobSql(where: string): string {
    return `SELECT job.id,job.layer_id AS "layerId",job.revision_id AS "revisionId",
                   job.status,job.phase,job.lock_version AS "lockVersion",
                   job.feature_total AS "featureTotal",job.feature_processed AS "featureProcessed",
                   job.attempts,job.result_snapshot_id AS "resultSnapshotId",
                   snapshot.generation::integer AS "resultGeneration",
                   job.failure_code AS "failureCode",
                   job.failure_correlation_id AS "failureCorrelationId",
                   job.created_at AS "createdAt",job.started_at AS "startedAt",
                   job.finished_at AS "finishedAt",job.updated_at AS "updatedAt"
            FROM publication_jobs job
            LEFT JOIN publication_snapshots snapshot ON snapshot.id=job.result_snapshot_id
            WHERE ${where}`;
  }

  private async reconciliationPage(
    manager: EntityManager,
    limit: number,
    cursorCreatedAt: Date | null,
    cursorJobId: string | null,
  ): Promise<Array<{ id: string; payloadVersion: number; createdAt: Date }>> {
    const cursorPredicate =
      cursorCreatedAt && cursorJobId
        ? `AND (job.created_at,job.id)>($2::timestamptz,$3::uuid)`
        : '';
    const parameters = cursorPredicate ? [limit, cursorCreatedAt, cursorJobId] : [limit];
    return this.rows<{ id: string; payloadVersion: number; createdAt: Date }>(
      await manager.query(
        `SELECT job.id,outbox.payload_version AS "payloadVersion",job.created_at AS "createdAt"
         FROM publication_jobs job
         JOIN publication_job_outbox outbox ON outbox.publication_job_id=job.id
         WHERE job.status='queued' ${cursorPredicate}
         ORDER BY job.created_at,job.id LIMIT $1`,
        parameters,
      ),
    );
  }

  private rows<T>(result: T[] | [T[], number]): T[] {
    return Array.isArray(result[0]) ? (result[0] as T[]) : (result as T[]);
  }
}
