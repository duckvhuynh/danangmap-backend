import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type {
  PublishRevisionDto,
  RequestChangesDto,
  SubmitRevisionDto,
  WorkflowCommentDto,
} from '../layers/layer.dto';
import { revisionEtag } from '../layers/etag';
import { touchLayerAggregate } from '../layers/layer-aggregate-version';
import {
  publicationReceiptMetadata,
  replayPublicationReceipt,
  synchronousPublicationResult,
  type PublicationReceiptMetadata,
} from '../publications/publication-result';

interface Actor {
  id: string;
  role: string;
}

interface RevisionRow {
  id: string;
  layer_id: string;
  revision_no: number;
  status: string;
  created_by: string;
  title: string;
  description: string | null;
  geometry_mode: string;
  allowed_geometry_kinds: string[];
  style: Record<string, unknown>;
  render_config: Record<string, unknown>;
  popup_config: Record<string, unknown>;
  schema_version: number;
  lock_version: number;
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async submit(
    revisionId: string,
    dto: SubmitRevisionDto,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    const requestDigest = this.idempotency.digest({ revisionId, dto });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{ revisionId: string; status: string }>(
        manager,
        actor.id,
        'revision.submit',
        idempotencyKey,
        requestDigest,
      );
      if (!receipt.owner) return this.replayed(receipt.response);
      const revision = await this.lockRevision(manager, revisionId);
      if (revision.status !== 'draft') this.invalidTransition();
      if (revision.created_by !== actor.id) {
        const participation = await this.hasParticipation(manager, revisionId, actor.id, 'edit');
        if (!participation) {
          throw new AppException(
            403,
            'SEPARATION_OF_DUTIES',
            'Chỉ Editor tham gia revision mới được gửi duyệt.',
          );
        }
      }
      const validationRows = (await manager.query(
        `
          SELECT count(*) FILTER (WHERE NOT ST_IsValid(fv.geometry))::integer AS invalid_geometry
          FROM revision_features rf JOIN feature_versions fv ON fv.id=rf.feature_version_id
          WHERE rf.revision_id=$1
        `,
        [revisionId],
      )) as Array<{ invalid_geometry: number }>;
      if (validationRows[0]?.invalid_geometry) {
        throw new AppException(422, 'GEOMETRY_INVALID', 'Revision còn geometry không hợp lệ.');
      }
      await manager.query(
        `UPDATE layer_revisions SET status='in_review',submitted_at=now(),lock_version=lock_version+1,updated_at=now() WHERE id=$1`,
        [revisionId],
      );
      await touchLayerAggregate(manager, revision.layer_id);
      await this.event(manager, revisionId, 'draft', 'in_review', actor.id, dto.summary);
      await this.audit(manager, actor, requestId, 'revision.submitted', revisionId, {
        summary: dto.summary,
        reviewerNote: dto.reviewerNote ?? null,
      });
      const response = { revisionId, status: 'in_review' };
      await this.idempotency.complete(
        manager,
        actor.id,
        'revision.submit',
        idempotencyKey,
        response,
        202,
      );
      return response;
    });
  }

  async approve(
    revisionId: string,
    dto: WorkflowCommentDto,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    const requestDigest = this.idempotency.digest({ revisionId, dto });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{ revisionId: string; status: string }>(
        manager,
        actor.id,
        'revision.approve',
        idempotencyKey,
        requestDigest,
      );
      if (!receipt.owner) return this.replayed(receipt.response);
      const revision = await this.lockRevision(manager, revisionId);
      if (revision.status !== 'in_review') this.invalidTransition();
      await this.assertCanReview(manager, revision, actor.id);
      await manager.query(
        `UPDATE layer_revisions SET status='approved',approved_at=now(),lock_version=lock_version+1,updated_at=now() WHERE id=$1`,
        [revisionId],
      );
      await touchLayerAggregate(manager, revision.layer_id);
      await manager.query(
        `INSERT INTO revision_participants(revision_id,user_id,participation_type)
         VALUES($1,$2,'review') ON CONFLICT DO NOTHING`,
        [revisionId, actor.id],
      );
      await this.event(manager, revisionId, 'in_review', 'approved', actor.id, dto.comment ?? null);
      await this.audit(manager, actor, requestId, 'revision.approved', revisionId, {
        comment: dto.comment ?? null,
      });
      const response = { revisionId, status: 'approved' };
      await this.idempotency.complete(
        manager,
        actor.id,
        'revision.approve',
        idempotencyKey,
        response,
        201,
      );
      return response;
    });
  }

  async requestChanges(
    revisionId: string,
    dto: RequestChangesDto,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    const requestDigest = this.idempotency.digest({ revisionId, dto });
    try {
      return await this.dataSource.transaction(async (manager) => {
        const receipt = await this.idempotency.claim<Record<string, unknown>>(
          manager,
          actor.id,
          'revision.request_changes',
          idempotencyKey,
          requestDigest,
        );
        if (!receipt.owner) return this.replayed(receipt.response);

        const identityRows = (await manager.query(
          `SELECT layer_id FROM layer_revisions WHERE id=$1`,
          [revisionId],
        )) as Array<{ layer_id: string }>;
        const identity = identityRows[0];
        if (!identity) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
        await manager.query(`SELECT id FROM layers WHERE id=$1 FOR UPDATE`, [identity.layer_id]);

        const revision = await this.lockRevision(manager, revisionId);
        if (revision.status !== 'in_review') this.invalidTransition();
        await this.assertCanReview(manager, revision, actor.id);
        const existingDraft = (await manager.query(
          `SELECT id FROM layer_revisions WHERE layer_id=$1 AND status='draft' LIMIT 1`,
          [revision.layer_id],
        )) as Array<{ id: string }>;
        if (existingDraft.length) {
          throw new AppException(409, 'DRAFT_ALREADY_EXISTS', 'Layer đã có draft đang hoạt động.');
        }
        const revisionNumberRows = (await manager.query(
          `SELECT COALESCE(max(revision_no),0)+1 AS revision_no
           FROM layer_revisions WHERE layer_id=$1`,
          [revision.layer_id],
        )) as Array<{ revision_no: string }>;
        const nextRevisionNumber = Number(revisionNumberRows[0]!.revision_no);
        await manager.query(
          `UPDATE layer_revisions SET status='changes_requested',lock_version=lock_version+1,updated_at=now() WHERE id=$1`,
          [revisionId],
        );
        const successorRows = (await manager.query(
          `
            INSERT INTO layer_revisions(
              layer_id,revision_no,status,title,description,geometry_mode,allowed_geometry_kinds,
              style,render_config,popup_config,schema_version,lock_version,cursor_seq,created_by,supersedes_revision_id
            ) VALUES($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,1,0,$11,$12)
            RETURNING id
          `,
          [
            revision.layer_id,
            nextRevisionNumber,
            revision.title,
            revision.description,
            revision.geometry_mode,
            revision.allowed_geometry_kinds,
            JSON.stringify(revision.style),
            JSON.stringify(revision.render_config),
            JSON.stringify(revision.popup_config),
            revision.schema_version,
            revision.created_by,
            revisionId,
          ],
        )) as Array<{ id: string }>;
        const successorId = successorRows[0]!.id;
        await manager.query(
          `
            INSERT INTO layer_fields(
              revision_id,key,label,description,type,icon,required,public,searchable,filterable,
              sortable,sensitive,offline_cache,default_value,validation,options,display_order
            )
            SELECT $2,key,label,description,type,icon,required,public,searchable,filterable,
              sortable,sensitive,offline_cache,default_value,validation,options,display_order
            FROM layer_fields WHERE revision_id=$1
          `,
          [revisionId, successorId],
        );
        await manager.query(
          `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
           SELECT $2,feature_id,feature_version_id,ordinal FROM revision_features WHERE revision_id=$1`,
          [revisionId, successorId],
        );
        await manager.query(
          `INSERT INTO revision_participants(revision_id,user_id,participation_type)
           VALUES($1,$2,'review'),($3,$4,'edit') ON CONFLICT DO NOTHING`,
          [revisionId, actor.id, successorId, revision.created_by],
        );
        await touchLayerAggregate(manager, revision.layer_id);
        await this.event(
          manager,
          revisionId,
          'in_review',
          'changes_requested',
          actor.id,
          dto.comment,
        );
        await this.audit(manager, actor, requestId, 'revision.changes_requested', revisionId, {
          comment: dto.comment,
          successorRevisionId: successorId,
        });
        const response = {
          originalRevisionId: revisionId,
          draftRevisionId: successorId,
          supersedesRevisionId: revisionId,
          originalStatus: 'changes_requested',
          draftStatus: 'draft',
          draftEtag: revisionEtag(successorId, 1),
        };
        await this.idempotency.complete(
          manager,
          actor.id,
          'revision.request_changes',
          idempotencyKey,
          response,
          201,
          response.draftEtag,
        );
        return response;
      });
    } catch (error) {
      this.rethrowDraftConflict(error);
    }
  }

  async publish(
    revisionId: string,
    dto: PublishRevisionDto,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    const requestDigest = this.idempotency.digest({ revisionId, dto });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<
        Record<string, unknown>,
        PublicationReceiptMetadata
      >(manager, actor.id, 'revision.publish', idempotencyKey, requestDigest);
      if (!receipt.owner) return replayPublicationReceipt(receipt);
      const revisionIdentity = await this.revisionIdentity(manager, revisionId);
      await this.lockLayer(manager, revisionIdentity.layer_id);
      const revision = await this.lockRevision(manager, revisionId);
      if (revision.status !== 'approved') this.invalidTransition();
      if (await this.hasAnyParticipation(manager, revisionId, actor.id, ['edit', 'review'])) {
        throw new AppException(
          403,
          'SEPARATION_OF_DUTIES',
          'Publisher đã tham gia biên tập hoặc kiểm duyệt revision này.',
        );
      }
      await this.assertPublicationBaseCurrent(manager, revision);
      await this.assertAttachmentsPublishable(manager, revisionId);
      await manager.query(
        `UPDATE layer_revisions SET status='publishing',updated_at=now() WHERE id=$1`,
        [revisionId],
      );
      const aggregates = (await manager.query(
        `
          SELECT count(*)::integer AS feature_count,
            CASE WHEN count(*)=0 THEN NULL ELSE ARRAY[
              ST_XMin(ST_Extent(fv.geometry)),ST_YMin(ST_Extent(fv.geometry)),
              ST_XMax(ST_Extent(fv.geometry)),ST_YMax(ST_Extent(fv.geometry))
            ] END AS bounds,
            COALESCE(string_agg(fv.checksum,'' ORDER BY rf.feature_id),'') AS checksum_input
          FROM revision_features rf JOIN feature_versions fv ON fv.id=rf.feature_version_id
          WHERE rf.revision_id=$1
        `,
        [revisionId],
      )) as Array<{ feature_count: number; bounds: number[] | null; checksum_input: string }>;
      const aggregate = aggregates[0] ?? { feature_count: 0, bounds: null, checksum_input: '' };
      const generationRows = (await manager.query(
        `SELECT COALESCE(max(generation),0)+1 AS generation FROM publication_snapshots WHERE layer_id=$1`,
        [revision.layer_id],
      )) as Array<{ generation: string }>;
      const generation = generationRows[0]!.generation;
      const checksum = this.crypto.checksum(aggregate.checksum_input);
      const snapshotRows = (await manager.query(
        `
          INSERT INTO publication_snapshots(
            layer_id,revision_id,status,generation,feature_count,bounds,checksum,manifest,published_by,published_at
          ) VALUES($1,$2,'published',$3,$4,$5,$6,$7::jsonb,$8,now()) RETURNING id
        `,
        [
          revision.layer_id,
          revisionId,
          generation,
          aggregate.feature_count,
          aggregate.bounds,
          checksum,
          JSON.stringify({
            sourceKind: 'geojson',
            sourceLayer: 'features',
            schemaVersion: revision.schema_version,
            attachmentProjection: 'versioned',
          }),
          actor.id,
        ],
      )) as Array<{ id: string }>;
      const snapshotId = snapshotRows[0]!.id;
      await manager.query(
        `
          INSERT INTO layer_publications(layer_id,active_snapshot_id,previous_snapshot_id,pointer_updated_at)
          VALUES($1,$2,NULL,now())
          ON CONFLICT(layer_id) DO UPDATE SET
            previous_snapshot_id=layer_publications.active_snapshot_id,
            active_snapshot_id=EXCLUDED.active_snapshot_id,
            pointer_updated_at=now()
        `,
        [revision.layer_id, snapshotId],
      );
      await manager.query(`UPDATE publication_snapshots SET activated_at=now() WHERE id=$1`, [
        snapshotId,
      ]);
      await manager.query(
        `UPDATE layer_revisions SET status='published',published_at=now(),lock_version=lock_version+1,updated_at=now() WHERE id=$1`,
        [revisionId],
      );
      await touchLayerAggregate(manager, revision.layer_id);
      await manager.query(
        `INSERT INTO revision_participants(revision_id,user_id,participation_type)
         VALUES($1,$2,'publish') ON CONFLICT DO NOTHING`,
        [revisionId, actor.id],
      );
      await this.event(manager, revisionId, 'approved', 'published', actor.id, dto.releaseNote);
      await this.audit(manager, actor, requestId, 'revision.published', revisionId, {
        snapshotId,
        generation,
        releaseNote: dto.releaseNote,
      });
      const response = {
        publicationId: snapshotId,
        snapshotId,
        generation: Number(generation),
        status: 'completed',
      };
      const result = synchronousPublicationResult(response);
      await this.idempotency.complete(
        manager,
        actor.id,
        'revision.publish',
        idempotencyKey,
        response,
        202,
        null,
        publicationReceiptMetadata(result),
      );
      return result;
    });
  }

  private async lockRevision(manager: DataSource['manager'], id: string): Promise<RevisionRow> {
    const rows = (await manager.query(`SELECT * FROM layer_revisions WHERE id=$1 FOR UPDATE`, [
      id,
    ])) as RevisionRow[];
    const revision = rows[0];
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    return revision;
  }

  private async revisionIdentity(
    manager: DataSource['manager'],
    revisionId: string,
  ): Promise<{ layer_id: string }> {
    const rows = (await manager.query(`SELECT layer_id FROM layer_revisions WHERE id=$1`, [
      revisionId,
    ])) as Array<{ layer_id: string }>;
    const identity = rows[0];
    if (!identity) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    return identity;
  }

  private async lockLayer(manager: DataSource['manager'], layerId: string): Promise<void> {
    const rows = (await manager.query(`SELECT id FROM layers WHERE id=$1 FOR UPDATE`, [
      layerId,
    ])) as Array<{ id: string }>;
    if (!rows[0]) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer.');
  }

  private async assertPublicationBaseCurrent(
    manager: DataSource['manager'],
    revision: RevisionRow,
  ): Promise<void> {
    const activeRows = (await manager.query(
      `SELECT snapshot.revision_id
       FROM layer_publications publication
       JOIN publication_snapshots snapshot ON snapshot.id=publication.active_snapshot_id
       WHERE publication.layer_id=$1
       FOR UPDATE OF publication`,
      [revision.layer_id],
    )) as Array<{ revision_id: string }>;
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
    const activeRevisionId = activeRows[0]?.revision_id ?? null;
    const baseRevisionId = ancestorRows[0]?.id ?? null;
    if (activeRevisionId !== baseRevisionId) {
      throw new AppException(
        409,
        'PUBLICATION_BASE_STALE',
        'Revision được tạo từ một publication không còn hiện hành.',
        { activeRevisionId, baseRevisionId },
      );
    }
  }

  private async assertAttachmentsPublishable(
    manager: DataSource['manager'],
    revisionId: string,
  ): Promise<void> {
    const rows = (await manager.query(
      `SELECT (
         SELECT count(*)::integer
         FROM revision_features member
         JOIN feature_versions version ON version.id=member.feature_version_id
         JOIN layer_fields field
           ON field.revision_id=$1 AND field.type IN ('image','attachment')
         WHERE member.revision_id=$1 AND (
           (field.required AND NOT EXISTS (
             SELECT 1 FROM feature_version_attachments required_link
             JOIN attachments required_attachment
               ON required_attachment.id=required_link.attachment_id
             WHERE required_link.feature_version_id=version.id
               AND required_link.field_key=field.key
               AND required_attachment.status='clean'
               AND required_attachment.object_key IS NOT NULL
           )) OR
           COALESCE(version.properties->field.key,'[]'::jsonb) IS DISTINCT FROM COALESCE((
             SELECT jsonb_agg(link.attachment_id ORDER BY link.display_order,link.attachment_id)
             FROM feature_version_attachments link
             JOIN attachments attachment ON attachment.id=link.attachment_id
             WHERE link.feature_version_id=version.id AND link.field_key=field.key
               AND attachment.status='clean' AND attachment.object_key IS NOT NULL
           ),'[]'::jsonb)
         )
       ) + (
         SELECT count(*)::integer
         FROM revision_features linked_member
         JOIN feature_version_attachments link
           ON link.feature_version_id=linked_member.feature_version_id
         LEFT JOIN attachments attachment ON attachment.id=link.attachment_id
         LEFT JOIN layer_fields attachment_field
           ON attachment_field.revision_id=$1 AND attachment_field.key=link.field_key
         WHERE linked_member.revision_id=$1 AND (
           attachment.status IS DISTINCT FROM 'clean' OR attachment.object_key IS NULL
           OR attachment_field.type IS NULL
           OR attachment_field.type NOT IN ('image','attachment')
         )
       ) AS invalid`,
      [revisionId],
    )) as Array<{ invalid: number }>;
    if (Number(rows[0]?.invalid ?? 0) > 0) {
      throw new AppException(
        409,
        'ATTACHMENT_NOT_READY',
        'Revision có tệp đính kèm chưa sạch, thiếu hoặc không khớp version.',
      );
    }
  }

  private async assertCanReview(
    manager: DataSource['manager'],
    revision: RevisionRow,
    actorId: string,
  ): Promise<void> {
    if (
      revision.created_by === actorId ||
      (await this.hasParticipation(manager, revision.id, actorId, 'edit'))
    ) {
      throw new AppException(
        403,
        'SEPARATION_OF_DUTIES',
        'Không được tự kiểm duyệt revision đã biên tập.',
      );
    }
  }

  private async hasParticipation(
    manager: DataSource['manager'],
    revisionId: string,
    userId: string,
    type: string,
  ): Promise<boolean> {
    const rows = (await manager.query(
      `SELECT 1 FROM revision_participants WHERE revision_id=$1 AND user_id=$2 AND participation_type=$3 LIMIT 1`,
      [revisionId, userId, type],
    )) as Array<{ '?column?': number }>;
    return rows.length > 0;
  }

  private async hasAnyParticipation(
    manager: DataSource['manager'],
    revisionId: string,
    userId: string,
    types: string[],
  ): Promise<boolean> {
    const rows = (await manager.query(
      `SELECT 1 FROM revision_participants WHERE revision_id=$1 AND user_id=$2 AND participation_type=ANY($3::text[]) LIMIT 1`,
      [revisionId, userId, types],
    )) as Array<{ '?column?': number }>;
    return rows.length > 0;
  }

  private async event(
    manager: DataSource['manager'],
    revisionId: string,
    from: string,
    to: string,
    actorId: string,
    reason: string | null,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO workflow_events(revision_id,from_status,to_status,actor_id,reason) VALUES($1,$2,$3,$4,$5)`,
      [revisionId, from, to, actorId, reason],
    );
  }

  private async audit(
    manager: DataSource['manager'],
    actor: Actor,
    requestId: string,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
       VALUES($1,$2,$3,'layer_revision',$4,$5,$6::jsonb)`,
      [actor.id, actor.role, action, resourceId, requestId, JSON.stringify(metadata)],
    );
  }

  private invalidTransition(): never {
    throw new AppException(
      409,
      'WORKFLOW_TRANSITION_INVALID',
      'Chuyển trạng thái revision không hợp lệ.',
    );
  }

  private rethrowDraftConflict(error: unknown): never {
    if (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string; constraint?: string }).code === '23505' &&
      [
        'uq_layer_active_draft',
        'uq_layer_open_editorial_chain',
        'uq_layer_revision_number',
      ].includes((error.driverError as { constraint?: string }).constraint ?? '')
    ) {
      throw new AppException(409, 'DRAFT_ALREADY_EXISTS', 'Layer đã có draft đang hoạt động.');
    }
    throw error;
  }

  private replayed<T>(response: T | null): T {
    if (response) return response;
    throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
  }
}
