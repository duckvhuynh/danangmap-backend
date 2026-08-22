import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { PublishRevisionDto } from '../layers/layer.dto';
import type { PublicationJobView } from './publication.dto';
import { PublicationFingerprintService } from './publication-fingerprint.service';
import { PublicationJobRepository } from './publication-job.repository';
import {
  asynchronousPublicationResult,
  publicationReceiptMetadata,
  replayPublicationReceipt,
  type PublicationExecutionResult,
  type PublicationReceiptMetadata,
} from './publication-result';
import { publicationJobEtag, publicationJobView } from './publication-view';

interface Actor {
  id: string;
  role: string;
}

interface RevisionRow {
  id: string;
  layer_id: string;
  status: string;
  schema_version: number;
  lock_version: number;
}

interface ActivePointer {
  snapshotId: string | null;
  generation: number | null;
  revisionId: string | null;
}

@Injectable()
export class PublicationAdmissionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly fingerprint: PublicationFingerprintService,
    private readonly idempotency: IdempotencyService,
    private readonly repository: PublicationJobRepository,
    private readonly config: ConfigService,
  ) {}

  async admit(
    revisionId: string,
    dto: PublishRevisionDto,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ): Promise<PublicationExecutionResult<PublicationJobView>> {
    if (dto.clientIntent !== 'desktop') {
      throw new AppException(
        400,
        'BAD_REQUEST',
        'Publish bất đồng bộ chỉ chấp nhận clientIntent desktop.',
      );
    }
    const requestDigest = this.idempotency.digest({ revisionId, dto });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<PublicationJobView, PublicationReceiptMetadata>(
        manager,
        actor.id,
        'revision.publish',
        idempotencyKey,
        requestDigest,
      );
      if (!receipt.owner) {
        return replayPublicationReceipt(receipt);
      }

      const identityRows = (await manager.query(
        `SELECT layer_id FROM layer_revisions WHERE id=$1`,
        [revisionId],
      )) as Array<{ layer_id: string }>;
      const identity = identityRows[0];
      if (!identity) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
      await this.lockLayer(manager, identity.layer_id);

      const activeJob = await this.repository.activeForLayer(manager, identity.layer_id);
      if (activeJob) {
        throw new AppException(409, 'PUBLICATION_JOB_ACTIVE', 'Layer đang có tác vụ công bố.', {
          publicationJobId: activeJob.id,
        });
      }
      const revision = await this.lockRevision(manager, revisionId);
      if (revision.status !== 'approved') {
        throw new AppException(
          409,
          'WORKFLOW_TRANSITION_INVALID',
          'Chuyển trạng thái revision không hợp lệ.',
        );
      }
      if (await this.hasEditorialParticipation(manager, revisionId, actor.id)) {
        throw new AppException(
          403,
          'SEPARATION_OF_DUTIES',
          'Publisher đã tham gia biên tập hoặc kiểm duyệt revision này.',
        );
      }
      const pointer = await this.assertPublicationBaseCurrent(manager, revision);
      const nextRevisionLockVersion = revision.lock_version + 1;
      const revisionFingerprint = await this.fingerprint.calculate(manager, revision.id);

      await manager.query(
        `UPDATE layer_revisions
         SET status='publishing',lock_version=$2,updated_at=now() WHERE id=$1`,
        [revisionId, nextRevisionLockVersion],
      );
      const row = await this.repository.insertAdmission(manager, {
        layerId: revision.layer_id,
        revisionId,
        requestedBy: actor.id,
        requestId,
        releaseNote: dto.releaseNote,
        expectedActiveSnapshotId: pointer.snapshotId,
        expectedActiveGeneration: pointer.generation,
        revisionLockVersion: nextRevisionLockVersion,
        revisionSchemaVersion: revision.schema_version,
        revisionFingerprint,
        maxAttempts: this.config.getOrThrow<number>('publication.maxAttempts'),
      });
      await manager.query(
        `INSERT INTO workflow_events(revision_id,from_status,to_status,actor_id,reason)
         VALUES($1,'approved','publishing',$2,$3)`,
        [revisionId, actor.id, dto.releaseNote],
      );
      await manager.query(
        `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
         VALUES($1,$2,'publication.queued','layer_revision',$3,$4,$5::jsonb)`,
        [
          actor.id,
          actor.role,
          revisionId,
          requestId,
          JSON.stringify({
            jobId: row.id,
            layerId: revision.layer_id,
            revisionId,
            clientIntent: 'desktop',
          }),
        ],
      );
      const response = publicationJobView(row);
      const etag = publicationJobEtag(row.id, row.lockVersion);
      const result = this.result(response, etag);
      await this.idempotency.complete(
        manager,
        actor.id,
        'revision.publish',
        idempotencyKey,
        response,
        202,
        etag,
        publicationReceiptMetadata(result),
      );
      return result;
    });
  }

  private result(
    data: PublicationJobView,
    etag: string,
  ): PublicationExecutionResult<PublicationJobView> {
    return asynchronousPublicationResult(
      data,
      etag,
      Math.max(
        1,
        Math.ceil(this.config.getOrThrow<number>('publication.dispatchIntervalMs') / 1_000),
      ),
    );
  }

  private async lockLayer(manager: EntityManager, layerId: string): Promise<void> {
    const rows = (await manager.query(`SELECT id FROM layers WHERE id=$1 FOR UPDATE`, [
      layerId,
    ])) as Array<{ id: string }>;
    if (!rows[0]) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer.');
  }

  private async lockRevision(manager: EntityManager, revisionId: string): Promise<RevisionRow> {
    const rows = (await manager.query(`SELECT * FROM layer_revisions WHERE id=$1 FOR UPDATE`, [
      revisionId,
    ])) as RevisionRow[];
    const row = rows[0];
    if (!row) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    return row;
  }

  private async hasEditorialParticipation(
    manager: EntityManager,
    revisionId: string,
    actorId: string,
  ): Promise<boolean> {
    const rows = (await manager.query(
      `SELECT 1 FROM revision_participants
       WHERE revision_id=$1 AND user_id=$2
         AND participation_type=ANY('{edit,review}'::text[]) LIMIT 1`,
      [revisionId, actorId],
    )) as Array<Record<string, unknown>>;
    return rows.length > 0;
  }

  private async assertPublicationBaseCurrent(
    manager: EntityManager,
    revision: RevisionRow,
  ): Promise<ActivePointer> {
    const activeRows = (await manager.query(
      `SELECT publication.active_snapshot_id AS "snapshotId",
              snapshot.generation::integer AS generation,snapshot.revision_id AS "revisionId"
       FROM layer_publications publication
       JOIN publication_snapshots snapshot ON snapshot.id=publication.active_snapshot_id
       WHERE publication.layer_id=$1 FOR UPDATE OF publication`,
      [revision.layer_id],
    )) as Array<{ snapshotId: string; generation: number; revisionId: string }>;
    const ancestorRows = (await manager.query(
      `WITH RECURSIVE lineage AS (
         SELECT ancestor.id,ancestor.status,ancestor.supersedes_revision_id,1 AS depth
         FROM layer_revisions candidate
         JOIN layer_revisions ancestor ON ancestor.id=candidate.supersedes_revision_id
         WHERE candidate.id=$1
         UNION ALL
         SELECT ancestor.id,ancestor.status,ancestor.supersedes_revision_id,lineage.depth+1
         FROM lineage
         JOIN layer_revisions ancestor ON ancestor.id=lineage.supersedes_revision_id
       )
       SELECT id FROM lineage WHERE status='published' ORDER BY depth LIMIT 1`,
      [revision.id],
    )) as Array<{ id: string }>;
    const active = activeRows[0];
    const activeRevisionId = active?.revisionId ?? null;
    const baseRevisionId = ancestorRows[0]?.id ?? null;
    if (activeRevisionId !== baseRevisionId) {
      throw new AppException(
        409,
        'PUBLICATION_BASE_STALE',
        'Revision được tạo từ một publication không còn hiện hành.',
        { activeRevisionId, baseRevisionId },
      );
    }
    return {
      snapshotId: active?.snapshotId ?? null,
      generation: active?.generation ?? null,
      revisionId: activeRevisionId,
    };
  }
}
