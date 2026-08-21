import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { publicationPointerEtag, requirePublicationPointerEtag } from '../layers/etag';
import type { RollbackDto } from '../layers/layer.dto';

interface Actor {
  id: string;
  role: string;
}

export interface RollbackResponse {
  publicationId: string;
  snapshotId: string;
  targetSnapshotId: string;
  generation: number;
  status: 'completed';
  activeRevisionId: string;
}

@Injectable()
export class PublicationRollbackService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async rollback(
    layerId: string,
    dto: RollbackDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ): Promise<{ data: RollbackResponse; etag: string }> {
    const expectedPointerEtag = requirePublicationPointerEtag(ifMatch);
    const requestDigest = this.idempotency.digest({ layerId, dto, ifMatch });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<RollbackResponse>(
        manager,
        actor.id,
        'layer.rollback',
        idempotencyKey,
        requestDigest,
      );
      if (!receipt.owner) {
        if (!receipt.response || !receipt.etag) {
          throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
        }
        return { data: receipt.response, etag: receipt.etag };
      }

      const layerRows = (await manager.query(
        `SELECT id,lock_version FROM layers WHERE id=$1 FOR UPDATE`,
        [layerId],
      )) as Array<{ id: string; lock_version: number }>;
      const layer = layerRows[0];
      if (!layer) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer.');
      const pointerRows = (await manager.query(
        `SELECT pointer.active_snapshot_id,pointer.previous_snapshot_id,
                active.generation::integer AS active_generation
         FROM layer_publications pointer
         JOIN publication_snapshots active ON active.id=pointer.active_snapshot_id
         WHERE pointer.layer_id=$1 FOR UPDATE OF pointer`,
        [layerId],
      )) as Array<{
        active_snapshot_id: string;
        previous_snapshot_id: string | null;
        active_generation: number;
      }>;
      const pointer = pointerRows[0];
      if (!pointer) {
        throw new AppException(
          409,
          'ROLLBACK_TARGET_INVALID',
          'Layer chưa có publication hiện hành để rollback.',
        );
      }
      const currentPointerEtag = publicationPointerEtag(
        layerId,
        pointer.active_snapshot_id,
        Number(pointer.active_generation),
      );
      if (expectedPointerEtag !== currentPointerEtag) {
        throw new AppException(412, 'ETAG_MISMATCH', 'Publication pointer đã thay đổi.', {
          currentEtag: currentPointerEtag,
        });
      }
      if (pointer.active_snapshot_id === dto.targetSnapshotId) {
        throw new AppException(
          409,
          'ROLLBACK_TARGET_ACTIVE',
          'Publication đích đang là publication hiện hành.',
        );
      }

      const targetRows = (await manager.query(
        `SELECT id,revision_id,feature_count,bounds,checksum,manifest,generation
         FROM publication_snapshots
         WHERE id=$1 AND layer_id=$2 AND status='published' AND published_at IS NOT NULL
           AND activated_at IS NOT NULL
         FOR SHARE`,
        [dto.targetSnapshotId, layerId],
      )) as Array<{
        id: string;
        revision_id: string;
        feature_count: number;
        bounds: number[] | null;
        checksum: string;
        manifest: Record<string, unknown>;
        generation: string;
      }>;
      const target = targetRows[0];
      if (!target) {
        throw new AppException(
          404,
          'ROLLBACK_TARGET_NOT_FOUND',
          'Publication đích không phải snapshot đã publish của layer này.',
        );
      }
      if (await this.hasEditorialParticipation(manager, target.revision_id, actor.id)) {
        throw new AppException(403, 'SEPARATION_OF_DUTIES', 'Publisher đã tham gia revision đích.');
      }

      const generationRows = (await manager.query(
        `SELECT COALESCE(max(generation),0)+1 AS generation
         FROM publication_snapshots WHERE layer_id=$1`,
        [layerId],
      )) as Array<{ generation: string }>;
      const generation = Number(generationRows[0]!.generation);
      const snapshotRows = (await manager.query(
        `INSERT INTO publication_snapshots(
           layer_id,revision_id,status,generation,feature_count,bounds,checksum,manifest,published_by,published_at
         ) VALUES($1,$2,'published',$3,$4,$5,$6,$7::jsonb,$8,now())
         RETURNING id`,
        [
          layerId,
          target.revision_id,
          generation,
          target.feature_count,
          target.bounds,
          target.checksum,
          JSON.stringify({
            ...target.manifest,
            rollbackOf: dto.targetSnapshotId,
            rollbackSourceGeneration: Number(target.generation),
          }),
          actor.id,
        ],
      )) as Array<{ id: string }>;
      const snapshotId = snapshotRows[0]!.id;
      const pointerUpdateResult = (await manager.query(
        `UPDATE layer_publications
         SET previous_snapshot_id=active_snapshot_id,active_snapshot_id=$2,pointer_updated_at=now()
         WHERE layer_id=$1
         RETURNING 1 AS updated`,
        [layerId, snapshotId],
      )) as Array<{ updated: number }> | [Array<{ updated: number }>, number];
      const pointerUpdates = Array.isArray(pointerUpdateResult[0])
        ? pointerUpdateResult[0]
        : pointerUpdateResult;
      if (pointerUpdates.length !== 1) {
        throw new AppException(
          409,
          'PUBLICATION_POINTER_STALE',
          'Publication pointer đã thay đổi.',
        );
      }
      await manager.query(`UPDATE publication_snapshots SET activated_at=now() WHERE id=$1`, [
        snapshotId,
      ]);
      const etag = publicationPointerEtag(layerId, snapshotId, generation);
      const response: RollbackResponse = {
        publicationId: snapshotId,
        snapshotId,
        targetSnapshotId: dto.targetSnapshotId,
        generation,
        status: 'completed',
        activeRevisionId: target.revision_id,
      };
      const before = {
        activeSnapshotId: pointer.active_snapshot_id,
        previousSnapshotId: pointer.previous_snapshot_id,
      };
      const after = {
        activeSnapshotId: snapshotId,
        previousSnapshotId: pointer.active_snapshot_id,
        generation,
      };
      await manager.query(
        `INSERT INTO audit_logs(
           actor_id,actor_role,action,resource_type,resource_id,request_id,
           before_digest,after_digest,metadata
         ) VALUES($1,$2,'publication.rolled_back','publication',$3,$4,$5,$6,$7::jsonb)`,
        [
          actor.id,
          actor.role,
          snapshotId,
          requestId,
          this.crypto.checksum(JSON.stringify(before)),
          this.crypto.checksum(JSON.stringify(after)),
          JSON.stringify({
            layerId,
            targetSnapshotId: dto.targetSnapshotId,
            targetGeneration: Number(target.generation),
            activeSnapshotId: snapshotId,
            activeRevisionId: target.revision_id,
            generation,
            reason: dto.reason,
            clientIntent: dto.clientIntent ?? null,
            publicCacheVersion: generation,
          }),
        ],
      );
      await this.idempotency.complete(
        manager,
        actor.id,
        'layer.rollback',
        idempotencyKey,
        response,
        201,
        etag,
      );
      return { data: response, etag };
    });
  }

  private async hasEditorialParticipation(
    manager: DataSource['manager'],
    revisionId: string,
    actorId: string,
  ): Promise<boolean> {
    const rows = (await manager.query(
      `SELECT 1 FROM revision_participants
       WHERE revision_id=$1 AND user_id=$2 AND participation_type=ANY('{edit,review}'::text[])
       LIMIT 1`,
      [revisionId, actorId],
    )) as Array<Record<string, unknown>>;
    return rows.length > 0;
  }
}
