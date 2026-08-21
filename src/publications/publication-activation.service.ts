import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { PublicationFingerprintService } from './publication-fingerprint.service';
import type { PublicationFailureCode } from './publication-worker.errors';

interface ActivationJobRow {
  id: string;
  layer_id: string;
  revision_id: string;
  requested_by: string;
  request_id: string;
  release_note: string;
  expected_active_snapshot_id: string | null;
  expected_active_generation: string | null;
  revision_lock_version: number;
  revision_fingerprint: string;
  status: string;
  phase: string;
  lease_token: string | null;
  feature_total: number | null;
  feature_processed: number;
  vertex_processed: string;
  build_feature_count: number | null;
  build_bounds: number[] | null;
  build_checksum: string | null;
  build_manifest: Record<string, unknown> | null;
  result_snapshot_id: string | null;
}

@Injectable()
export class PublicationActivationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly crypto: CryptoService,
    private readonly fingerprint: PublicationFingerprintService,
  ) {}

  async activate(
    jobId: string,
    leaseToken: string,
  ): Promise<{ activated: boolean; snapshotId: string | null; generation: number | null }> {
    return this.dataSource.transaction(async (manager) => {
      const job = await this.lockJob(manager, jobId);
      if (!job) return { activated: false, snapshotId: null, generation: null };
      if (job.status === 'succeeded') {
        const snapshot = await this.snapshotResult(manager, job.result_snapshot_id);
        return {
          activated: false,
          snapshotId: job.result_snapshot_id,
          generation: snapshot?.generation ?? null,
        };
      }
      if (
        job.status !== 'building' ||
        job.phase !== 'switching' ||
        job.lease_token !== leaseToken ||
        !(await this.leaseIsLive(manager, job.id, leaseToken))
      ) {
        return { activated: false, snapshotId: null, generation: null };
      }

      await this.lockLayer(manager, job.layer_id);
      const revisionRows = (await manager.query(
        `SELECT id,status,lock_version FROM layer_revisions WHERE id=$1 FOR UPDATE`,
        [job.revision_id],
      )) as Array<{ id: string; status: string; lock_version: number }>;
      const revision = revisionRows[0];
      if (
        !revision ||
        revision.status !== 'publishing' ||
        revision.lock_version !== job.revision_lock_version ||
        (await this.fingerprint.calculate(manager, job.revision_id)) !== job.revision_fingerprint
      ) {
        throw new PublicationActivationInvariantError('PUBLICATION_INPUT_INVALID');
      }
      await this.assertActorAndSeparation(manager, job);

      const pointerRows = (await manager.query(
        `SELECT pointer.active_snapshot_id,
                snapshot.generation::integer AS active_generation
         FROM layer_publications pointer
         JOIN publication_snapshots snapshot ON snapshot.id=pointer.active_snapshot_id
         WHERE pointer.layer_id=$1 FOR UPDATE OF pointer`,
        [job.layer_id],
      )) as Array<{ active_snapshot_id: string; active_generation: number }>;
      const pointer = pointerRows[0] ?? null;
      if (
        (pointer?.active_snapshot_id ?? null) !== job.expected_active_snapshot_id ||
        (pointer?.active_generation ?? null) !==
          (job.expected_active_generation === null ? null : Number(job.expected_active_generation))
      ) {
        throw new PublicationActivationInvariantError('PUBLICATION_BASE_STALE');
      }
      if (
        job.feature_total === null ||
        job.feature_total !== job.feature_processed ||
        job.build_feature_count !== job.feature_total ||
        !job.build_checksum ||
        !job.build_manifest
      ) {
        throw new PublicationActivationInvariantError('PUBLICATION_INPUT_INVALID');
      }

      const generationRows = (await manager.query(
        `SELECT COALESCE(max(generation),0)+1 AS generation
         FROM publication_snapshots WHERE layer_id=$1`,
        [job.layer_id],
      )) as Array<{ generation: string }>;
      const generation = Number(generationRows[0]!.generation);
      const snapshotRows = (await manager.query(
        `INSERT INTO publication_snapshots(
           layer_id,revision_id,status,generation,feature_count,bounds,
           checksum,manifest,published_by,published_at
         ) VALUES($1,$2,'published',$3,$4,$5,$6,$7::jsonb,$8,now()) RETURNING id`,
        [
          job.layer_id,
          job.revision_id,
          generation,
          job.feature_total,
          job.build_bounds,
          job.build_checksum,
          JSON.stringify(job.build_manifest),
          job.requested_by,
        ],
      )) as Array<{ id: string }>;
      const snapshotId = snapshotRows[0]!.id;
      await manager.query(
        `INSERT INTO layer_publications(
           layer_id,active_snapshot_id,previous_snapshot_id,pointer_updated_at
         ) VALUES($1,$2,NULL,now())
         ON CONFLICT(layer_id) DO UPDATE SET
           previous_snapshot_id=layer_publications.active_snapshot_id,
           active_snapshot_id=EXCLUDED.active_snapshot_id,pointer_updated_at=now()`,
        [job.layer_id, snapshotId],
      );
      await manager.query(`UPDATE publication_snapshots SET activated_at=now() WHERE id=$1`, [
        snapshotId,
      ]);
      await manager.query(
        `UPDATE layer_revisions
         SET status='published',published_at=now(),lock_version=lock_version+1,updated_at=now()
         WHERE id=$1`,
        [job.revision_id],
      );
      await manager.query(
        `INSERT INTO revision_participants(revision_id,user_id,participation_type)
         VALUES($1,$2,'publish') ON CONFLICT DO NOTHING`,
        [job.revision_id, job.requested_by],
      );
      await manager.query(
        `INSERT INTO workflow_events(revision_id,from_status,to_status,actor_id,reason)
         VALUES($1,'publishing','published',$2,$3)`,
        [job.revision_id, job.requested_by, job.release_note],
      );
      await manager.query(
        `INSERT INTO audit_logs(
           actor_id,actor_role,action,resource_type,resource_id,request_id,
           before_digest,after_digest,metadata
         ) VALUES($1,'publisher','revision.published','layer_revision',$2,$3,$4,$5,$6::jsonb)`,
        [
          job.requested_by,
          job.revision_id,
          job.request_id,
          this.crypto.checksum(
            JSON.stringify({ activeSnapshotId: job.expected_active_snapshot_id }),
          ),
          this.crypto.checksum(JSON.stringify({ activeSnapshotId: snapshotId, generation })),
          JSON.stringify({
            jobId: job.id,
            layerId: job.layer_id,
            revisionId: job.revision_id,
            snapshotId,
            generation,
            releaseNote: job.release_note,
            featureCount: job.feature_total,
            clientIntent: 'desktop',
            publicCacheVersion: generation,
          }),
        ],
      );
      await manager.query(
        `UPDATE publication_jobs
         SET status='succeeded',phase='completed',result_snapshot_id=$3,
             lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
             finished_at=now(),lock_version=lock_version+1
         WHERE id=$1 AND lease_token=$2`,
        [job.id, leaseToken, snapshotId],
      );
      await manager.query(
        `UPDATE publication_worker_state
         SET completed_job_count=completed_job_count+1,worker_heartbeat_at=now(),updated_at=now()
         WHERE id=1`,
      );
      return { activated: true, snapshotId, generation };
    });
  }

  async fail(
    jobId: string,
    leaseToken: string | null,
    code: PublicationFailureCode,
    correlationId: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const job = await this.lockJob(manager, jobId);
      if (!job || job.status === 'succeeded' || job.status === 'failed') return false;
      if (job.status === 'building' && job.lease_token !== leaseToken) return false;
      if (job.status === 'queued' && leaseToken !== null) return false;

      await this.lockLayer(manager, job.layer_id);
      const revisionRows = (await manager.query(
        `SELECT status FROM layer_revisions WHERE id=$1 FOR UPDATE`,
        [job.revision_id],
      )) as Array<{ status: string }>;
      const transitioned = revisionRows[0]?.status === 'publishing';
      if (transitioned) {
        await manager.query(
          `UPDATE layer_revisions
           SET status='approved',lock_version=lock_version+1,updated_at=now() WHERE id=$1`,
          [job.revision_id],
        );
        await manager.query(
          `INSERT INTO workflow_events(revision_id,from_status,to_status,actor_id,reason)
           VALUES($1,'publishing','approved',$2,$3)`,
          [job.revision_id, job.requested_by, code],
        );
      }
      await manager.query(
        `UPDATE publication_jobs
         SET status='failed',phase='failed',failure_code=$3,failure_correlation_id=$4,
             lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
             finished_at=now(),lock_version=lock_version+1
         WHERE id=$1 AND ($2::uuid IS NULL OR lease_token=$2)`,
        [job.id, leaseToken, code, correlationId],
      );
      await manager.query(
        `INSERT INTO audit_logs(
           actor_id,actor_role,action,resource_type,resource_id,request_id,metadata
         ) VALUES($1,$2,'publication.failed','layer_revision',$3,$4,$5::jsonb)`,
        [
          job.requested_by,
          await this.actorRole(manager, job.requested_by),
          job.revision_id,
          correlationId,
          JSON.stringify({
            jobId: job.id,
            layerId: job.layer_id,
            revisionId: job.revision_id,
            failureCode: code,
          }),
        ],
      );
      await manager.query(
        `UPDATE publication_worker_state
         SET failed_job_count=failed_job_count+1,worker_heartbeat_at=now(),updated_at=now()
         WHERE id=1`,
      );
      return true;
    });
  }

  private async assertActorAndSeparation(
    manager: EntityManager,
    job: ActivationJobRow,
  ): Promise<void> {
    const actorRows = (await manager.query(
      `SELECT status,role,disabled_at FROM users WHERE id=$1 FOR SHARE`,
      [job.requested_by],
    )) as Array<{ status: string; role: string; disabled_at: Date | null }>;
    const actor = actorRows[0];
    if (
      !actor ||
      actor.status !== 'active' ||
      actor.role !== 'publisher' ||
      actor.disabled_at !== null
    ) {
      throw new PublicationActivationInvariantError('PUBLICATION_ACTOR_INELIGIBLE');
    }
    const participants = (await manager.query(
      `SELECT 1 FROM revision_participants
       WHERE revision_id=$1 AND user_id=$2
         AND participation_type=ANY('{edit,review}'::text[]) LIMIT 1`,
      [job.revision_id, job.requested_by],
    )) as Array<Record<string, unknown>>;
    if (participants.length > 0) {
      throw new PublicationActivationInvariantError('PUBLICATION_SEPARATION_OF_DUTIES');
    }
  }

  private async lockJob(manager: EntityManager, jobId: string): Promise<ActivationJobRow | null> {
    const rows = (await manager.query(`SELECT * FROM publication_jobs WHERE id=$1 FOR UPDATE`, [
      jobId,
    ])) as ActivationJobRow[];
    return rows[0] ?? null;
  }

  private async lockLayer(manager: EntityManager, layerId: string): Promise<void> {
    const rows = (await manager.query(`SELECT id FROM layers WHERE id=$1 FOR UPDATE`, [
      layerId,
    ])) as Array<{ id: string }>;
    if (!rows[0]) throw new PublicationActivationInvariantError('PUBLICATION_INPUT_INVALID');
  }

  private async leaseIsLive(
    manager: EntityManager,
    jobId: string,
    leaseToken: string,
  ): Promise<boolean> {
    const rows = (await manager.query(
      `SELECT 1 FROM publication_jobs
       WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now()`,
      [jobId, leaseToken],
    )) as Array<Record<string, unknown>>;
    return rows.length === 1;
  }

  private async snapshotResult(
    manager: EntityManager,
    snapshotId: string | null,
  ): Promise<{ generation: number } | null> {
    if (!snapshotId) return null;
    const rows = (await manager.query(
      `SELECT generation::integer AS generation FROM publication_snapshots WHERE id=$1`,
      [snapshotId],
    )) as Array<{ generation: number }>;
    return rows[0] ?? null;
  }

  private async actorRole(manager: EntityManager, actorId: string): Promise<string> {
    const rows = (await manager.query(`SELECT role FROM users WHERE id=$1`, [actorId])) as Array<{
      role: string;
    }>;
    return rows[0]?.role ?? 'publisher';
  }
}

export class PublicationActivationInvariantError extends Error {
  constructor(readonly code: PublicationFailureCode) {
    super(code);
  }
}
