import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { canonicalPublicFieldSql } from '../common/public-field.policy';

export interface PublicationBuildJob {
  id: string;
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
  status: 'queued' | 'building' | 'succeeded' | 'failed';
  phase: 'queued' | 'preparing' | 'scanning_features' | 'switching' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number;
  featureTotal: number | null;
  featureProcessed: number;
  leaseToken: string | null;
  resultSnapshotId: string | null;
  availableAt: Date;
}

export type PublicationBuildClaim =
  | { kind: 'claimed'; job: PublicationBuildJob & { leaseToken: string } }
  | { kind: 'terminal'; job: PublicationBuildJob }
  | { kind: 'busy'; job: PublicationBuildJob }
  | { kind: 'exhausted'; job: PublicationBuildJob }
  | { kind: 'missing' };

export interface PublicationBuildContext {
  revisionStatus: string;
  revisionLockVersion: number;
  revisionSchemaVersion: number;
  layerId: string;
  allowedGeometryKinds: string[];
  actorStatus: string;
  actorRole: string;
  actorDisabledAt: Date | null;
  editorialParticipant: boolean;
  activeSnapshotId: string | null;
  activeGeneration: number | null;
  featureCount: number;
  vertexCount: number;
  invalidFeatureCount: number;
  missingRequiredCount: number;
  publicFieldKeys: string[];
}

export interface PublicProjectionRow {
  featureId: string;
  geometry: Record<string, unknown>;
  geometryKind: string;
  radiusM: number | null;
  properties: Record<string, unknown>;
  vertexCount: number;
  bounds: [number, number, number, number];
}

export interface PublicationBatchCheckpoint {
  batchNo: number;
  lastFeatureId: string;
}

@Injectable()
export class PublicationWorkerRepository {
  constructor(private readonly dataSource: DataSource) {}

  async claim(jobId: string, owner: string, leaseSeconds: number): Promise<PublicationBuildClaim> {
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockJob(manager, jobId);
      if (!row) return { kind: 'missing' };
      if (row.status === 'succeeded' || row.status === 'failed')
        return { kind: 'terminal', job: row };
      if (row.status === 'queued' && row.availableAt.getTime() > Date.now()) {
        return { kind: 'busy', job: row };
      }
      if (
        row.status === 'building' &&
        row.leaseToken &&
        (await this.hasLiveLease(manager, jobId, row.leaseToken))
      ) {
        return { kind: 'busy', job: row };
      }
      if (row.attempts >= row.maxAttempts) return { kind: 'exhausted', job: row };

      const leaseToken = randomUUID();
      const phase =
        row.featureTotal === null
          ? 'preparing'
          : row.featureProcessed >= row.featureTotal
            ? 'switching'
            : 'scanning_features';
      await manager.query(
        `UPDATE publication_jobs
         SET status='building',phase=$2,attempts=attempts+1,
             lease_token=$3,lease_owner=$4,
             lease_expires_at=now()+($5::text || ' seconds')::interval,
             heartbeat_at=now(),started_at=COALESCE(started_at,now()),
             available_at=now(),lock_version=lock_version+1
         WHERE id=$1`,
        [jobId, phase, leaseToken, owner, leaseSeconds],
      );
      const claimed = await this.lockJob(manager, jobId);
      if (!claimed?.leaseToken) throw new Error('Publication lease claim was not persisted.');
      return { kind: 'claimed', job: claimed as PublicationBuildJob & { leaseToken: string } };
    });
  }

  async heartbeat(jobId: string, leaseToken: string, leaseSeconds: number): Promise<boolean> {
    const rows = this.rows<Record<string, unknown>>(
      await this.dataSource.query(
        `UPDATE publication_jobs
         SET heartbeat_at=now(),lease_expires_at=now()+($3::text || ' seconds')::interval,
             lock_version=lock_version+1
         WHERE id=$1 AND status='building' AND lease_token=$2
         RETURNING 1`,
        [jobId, leaseToken, leaseSeconds],
      ),
    );
    return rows.length === 1;
  }

  async context(jobId: string, leaseToken: string): Promise<PublicationBuildContext | null> {
    const rows = this.rows<PublicationBuildContext>(
      await this.dataSource.query(
        `SELECT revision.status AS "revisionStatus",
                revision.lock_version AS "revisionLockVersion",
                revision.schema_version AS "revisionSchemaVersion",
                revision.layer_id AS "layerId",
                revision.allowed_geometry_kinds AS "allowedGeometryKinds",
                actor.status AS "actorStatus",actor.role AS "actorRole",
                actor.disabled_at AS "actorDisabledAt",
                EXISTS(
                  SELECT 1 FROM revision_participants participant
                  WHERE participant.revision_id=job.revision_id
                    AND participant.user_id=job.requested_by
                    AND participant.participation_type=ANY('{edit,review}'::text[])
                ) AS "editorialParticipant",
                pointer.active_snapshot_id AS "activeSnapshotId",
                active.generation::integer AS "activeGeneration",
                aggregate.feature_count AS "featureCount",
                aggregate.vertex_count AS "vertexCount",
                aggregate.invalid_feature_count AS "invalidFeatureCount",
                aggregate.missing_required_count AS "missingRequiredCount",
                ARRAY(
                  SELECT field.key FROM layer_fields field
                  WHERE field.revision_id=revision.id AND ${canonicalPublicFieldSql('field')}
                  ORDER BY field.display_order,field.id
                ) AS "publicFieldKeys"
         FROM publication_jobs job
         JOIN layer_revisions revision ON revision.id=job.revision_id
         JOIN users actor ON actor.id=job.requested_by
         LEFT JOIN layer_publications pointer ON pointer.layer_id=job.layer_id
         LEFT JOIN publication_snapshots active ON active.id=pointer.active_snapshot_id
         CROSS JOIN LATERAL (
           SELECT count(*)::integer AS feature_count,
                  COALESCE(sum(ST_NPoints(version.geometry)),0)::integer AS vertex_count,
                  count(*) FILTER (WHERE
                    feature.layer_id<>revision.layer_id OR feature.deleted_at IS NOT NULL
                    OR jsonb_typeof(version.properties)<>'object'
                    OR NOT (version.geometry_kind=ANY(revision.allowed_geometry_kinds))
                    OR ST_IsEmpty(version.geometry) OR NOT ST_IsValid(version.geometry)
                    OR (version.geometry_kind='circle' AND COALESCE(version.radius_m,0)<=0)
                    OR (version.geometry_kind<>'circle' AND version.radius_m IS NOT NULL)
                  )::integer AS invalid_feature_count,
                  COALESCE((
                    SELECT count(*)::integer
                    FROM revision_features required_feature
                    JOIN feature_versions required_version
                      ON required_version.id=required_feature.feature_version_id
                    JOIN layer_fields required_field
                      ON required_field.revision_id=revision.id AND required_field.required=true
                    WHERE required_feature.revision_id=revision.id
                      AND (
                        NOT (required_version.properties ? required_field.key)
                        OR required_version.properties->required_field.key='null'::jsonb
                      )
                  ),0)::integer AS missing_required_count
           FROM revision_features member
           JOIN features feature ON feature.id=member.feature_id
           JOIN feature_versions version ON version.id=member.feature_version_id
           WHERE member.revision_id=revision.id
         ) aggregate
         WHERE job.id=$1 AND job.status='building' AND job.lease_token=$2`,
        [jobId, leaseToken],
      ),
    );
    return rows[0] ?? null;
  }

  async setPrepared(
    jobId: string,
    leaseToken: string,
    total: number,
    leaseSeconds: number,
  ): Promise<void> {
    const rows = this.rows<Record<string, unknown>>(
      await this.dataSource.query(
        `UPDATE publication_jobs
         SET feature_total=$3,phase=CASE WHEN $3=0 THEN 'switching' ELSE 'scanning_features' END,
             heartbeat_at=now(),lease_expires_at=now()+($4::text || ' seconds')::interval,
             lock_version=lock_version+1
         WHERE id=$1 AND status='building' AND phase='preparing' AND lease_token=$2
           AND (feature_total IS NULL OR feature_total=$3)
         RETURNING 1`,
        [jobId, leaseToken, total, leaseSeconds],
      ),
    );
    if (rows.length !== 1) throw new PublicationLeaseLostError();
  }

  async checkpoint(jobId: string): Promise<PublicationBatchCheckpoint | null> {
    const rows = this.rows<PublicationBatchCheckpoint>(
      await this.dataSource.query(
        `SELECT batch_no AS "batchNo",last_feature_id AS "lastFeatureId"
         FROM publication_job_batches WHERE job_id=$1 ORDER BY batch_no DESC LIMIT 1`,
        [jobId],
      ),
    );
    return rows[0] ?? null;
  }

  async publicBatch(
    revisionId: string,
    afterFeatureId: string | null,
    limit: number,
  ): Promise<PublicProjectionRow[]> {
    return this.rows<PublicProjectionRow>(
      await this.dataSource.query(
        `SELECT feature.id AS "featureId",
                ST_AsGeoJSON(version.geometry,9,0)::jsonb AS geometry,
                version.geometry_kind AS "geometryKind",version.radius_m AS "radiusM",
                COALESCE((
                  SELECT jsonb_object_agg(entry.key,entry.value ORDER BY entry.key)
                  FROM jsonb_each(version.properties) entry
                  JOIN layer_fields field ON field.revision_id=$1 AND field.key=entry.key
                    AND ${canonicalPublicFieldSql('field')}
                ),'{}'::jsonb) AS properties,
                ST_NPoints(version.geometry)::integer AS "vertexCount",
                ARRAY[
                  ST_XMin(Box2D(version.geometry)),ST_YMin(Box2D(version.geometry)),
                  ST_XMax(Box2D(version.geometry)),ST_YMax(Box2D(version.geometry))
                ]::double precision[] AS bounds
         FROM revision_features member
         JOIN features feature ON feature.id=member.feature_id AND feature.deleted_at IS NULL
         JOIN feature_versions version ON version.id=member.feature_version_id
         WHERE member.revision_id=$1 AND ($2::uuid IS NULL OR feature.id>$2::uuid)
         ORDER BY feature.id LIMIT $3`,
        [revisionId, afterFeatureId, limit],
      ),
    );
  }

  async commitBatch(input: {
    jobId: string;
    leaseToken: string;
    batchNo: number;
    firstFeatureId: string;
    lastFeatureId: string;
    featureCount: number;
    vertexCount: number;
    bounds: [number, number, number, number] | null;
    checksum: string;
    projection: Array<Record<string, unknown>>;
    leaseSeconds: number;
  }): Promise<{ processed: number; total: number }> {
    return this.dataSource.transaction(async (manager) => {
      const jobRows = this.rows<{ featureTotal: number }>(
        await manager.query(
          `SELECT feature_total AS "featureTotal" FROM publication_jobs
           WHERE id=$1 AND status='building' AND phase='scanning_features'
             AND lease_token=$2 AND lease_expires_at>now()
           FOR UPDATE`,
          [input.jobId, input.leaseToken],
        ),
      );
      const job = jobRows[0];
      if (!job) throw new PublicationLeaseLostError();
      await manager.query(
        `INSERT INTO publication_job_batches(
           job_id,batch_no,first_feature_id,last_feature_id,feature_count,vertex_count,
           bounds,public_checksum,public_projection
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          input.jobId,
          input.batchNo,
          input.firstFeatureId,
          input.lastFeatureId,
          input.featureCount,
          input.vertexCount,
          input.bounds,
          input.checksum,
          JSON.stringify(input.projection),
        ],
      );
      const progressRows = this.rows<{
        processed: number;
        vertices: string;
        bounds: number[] | null;
      }>(
        await manager.query(
          `SELECT COALESCE(sum(feature_count),0)::integer AS processed,
                  COALESCE(sum(vertex_count),0)::bigint AS vertices,
                  CASE WHEN count(bounds)=0 THEN NULL ELSE ARRAY[
                    min(bounds[1]),min(bounds[2]),max(bounds[3]),max(bounds[4])
                  ] END AS bounds
           FROM publication_job_batches WHERE job_id=$1`,
          [input.jobId],
        ),
      );
      const progress = progressRows[0]!;
      if (progress.processed > job.featureTotal) {
        throw new Error('Publication batch progress exceeded measured total.');
      }
      await manager.query(
        `UPDATE publication_jobs
         SET feature_processed=$3,vertex_processed=$4,build_bounds=$5,
             heartbeat_at=now(),lease_expires_at=now()+($6::text || ' seconds')::interval,
             lock_version=lock_version+1
         WHERE id=$1 AND lease_token=$2`,
        [
          input.jobId,
          input.leaseToken,
          progress.processed,
          progress.vertices,
          progress.bounds,
          input.leaseSeconds,
        ],
      );
      return { processed: progress.processed, total: job.featureTotal };
    });
  }

  async batchChecksums(jobId: string): Promise<string[]> {
    const rows = this.rows<{ checksum: string }>(
      await this.dataSource.query(
        `SELECT public_checksum AS checksum FROM publication_job_batches
         WHERE job_id=$1 ORDER BY batch_no`,
        [jobId],
      ),
    );
    return rows.map((row) => row.checksum);
  }

  async markSwitching(
    jobId: string,
    leaseToken: string,
    checksum: string,
    manifest: Record<string, unknown>,
    leaseSeconds: number,
  ): Promise<void> {
    const rows = this.rows<Record<string, unknown>>(
      await this.dataSource.query(
        `UPDATE publication_jobs
         SET phase='switching',build_feature_count=feature_processed,
             build_checksum=$3,build_manifest=$4::jsonb,
             heartbeat_at=now(),lease_expires_at=now()+($5::text || ' seconds')::interval,
             lock_version=lock_version+1
         WHERE id=$1 AND status='building' AND lease_token=$2
           AND feature_total=feature_processed
           AND phase IN ('scanning_features','switching')
         RETURNING 1`,
        [jobId, leaseToken, checksum, JSON.stringify(manifest), leaseSeconds],
      ),
    );
    if (rows.length !== 1) throw new PublicationLeaseLostError();
  }

  async releaseForRetry(
    jobId: string,
    leaseToken: string,
    delayMilliseconds: number,
  ): Promise<boolean> {
    const rows = this.rows<Record<string, unknown>>(
      await this.dataSource.query(
        `UPDATE publication_jobs
         SET status='queued',phase='queued',lease_token=NULL,lease_owner=NULL,
             lease_expires_at=NULL,heartbeat_at=NULL,
             available_at=now()+($3::text || ' milliseconds')::interval,
             lock_version=lock_version+1
         WHERE id=$1 AND status='building' AND lease_token=$2 RETURNING 1`,
        [jobId, leaseToken, delayMilliseconds],
      ),
    );
    return rows.length === 1;
  }

  async requeueExpiredLeases(): Promise<string[]> {
    return this.dataSource.transaction(async (manager) => {
      const rows = this.rows<{ id: string }>(
        await manager.query(
          `UPDATE publication_jobs
           SET status='queued',phase='queued',lease_token=NULL,lease_owner=NULL,
               lease_expires_at=NULL,heartbeat_at=NULL,available_at=now(),
               lock_version=lock_version+1
           WHERE status='building' AND lease_expires_at<=now()
           RETURNING id`,
        ),
      );
      await manager.query(
        `UPDATE publication_worker_state
         SET worker_heartbeat_at=now(),last_recovery_sweep_at=now(),
             recovered_lease_count=recovered_lease_count+$1,
             queue_depth=(SELECT count(*)::integer FROM publication_jobs WHERE status='queued'),
             oldest_queued_age_seconds=COALESCE((
               SELECT floor(extract(epoch FROM now()-min(created_at)))::integer
               FROM publication_jobs WHERE status='queued'
             ),0),
             building_count=(SELECT count(*)::integer FROM publication_jobs WHERE status='building'),
             updated_at=now()
         WHERE id=1`,
        [rows.length],
      );
      return rows.map((row) => row.id);
    });
  }

  async workerHeartbeat(errorCode: string | null = null): Promise<void> {
    await this.dataSource.query(
      `UPDATE publication_worker_state
       SET worker_heartbeat_at=now(),
           queue_depth=(SELECT count(*)::integer FROM publication_jobs WHERE status='queued'),
           oldest_queued_age_seconds=COALESCE((
             SELECT floor(extract(epoch FROM now()-min(created_at)))::integer
             FROM publication_jobs WHERE status='queued'
           ),0),
           building_count=(SELECT count(*)::integer FROM publication_jobs WHERE status='building'),
           worker_error_code=$1,
           updated_at=now()
       WHERE id=1`,
      [errorCode],
    );
  }

  private async lockJob(
    manager: EntityManager,
    jobId: string,
  ): Promise<PublicationBuildJob | null> {
    const rows = this.rows<PublicationBuildJob>(
      await manager.query(
        `SELECT id,layer_id AS "layerId",revision_id AS "revisionId",
                requested_by AS "requestedBy",request_id AS "requestId",release_note AS "releaseNote",
                expected_active_snapshot_id AS "expectedActiveSnapshotId",
                expected_active_generation::integer AS "expectedActiveGeneration",
                revision_lock_version AS "revisionLockVersion",
                revision_schema_version AS "revisionSchemaVersion",
                revision_fingerprint AS "revisionFingerprint",status,phase,attempts,
                max_attempts AS "maxAttempts",feature_total AS "featureTotal",
                feature_processed AS "featureProcessed",lease_token AS "leaseToken",
                result_snapshot_id AS "resultSnapshotId",available_at AS "availableAt"
         FROM publication_jobs WHERE id=$1 FOR UPDATE`,
        [jobId],
      ),
    );
    return rows[0] ?? null;
  }

  private async hasLiveLease(
    manager: EntityManager,
    jobId: string,
    leaseToken: string,
  ): Promise<boolean> {
    const rows = this.rows<Record<string, unknown>>(
      await manager.query(
        `SELECT 1 FROM publication_jobs
         WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now()`,
        [jobId, leaseToken],
      ),
    );
    return rows.length === 1;
  }

  private rows<T>(result: T[] | [T[], number]): T[] {
    return Array.isArray(result[0]) ? (result[0] as T[]) : (result as T[]);
  }
}

export class PublicationLeaseLostError extends Error {
  constructor() {
    super('PUBLICATION_LEASE_LOST');
  }
}
