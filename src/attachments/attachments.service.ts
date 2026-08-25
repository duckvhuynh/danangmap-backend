import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { DataSource, type EntityManager } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { ATTACHMENT_QUEUE } from '../jobs/jobs.constants';
import { requireRevisionVersion, revisionEtag } from '../layers/etag';
import { ChangeFeedRetentionService } from '../layers/change-feed-retention.service';
import { StorageService } from '../storage/storage.service';
import type { BindAttachmentDto, CreateAttachmentUploadDto } from './attachment.dto';
import { AttachmentEntity, type AttachmentStatus } from './attachment.entities';
import {
  normalizeContentType,
  validateAttachmentBytes,
  validateDeclaredAttachment,
} from './attachment-file.policy';
import { enqueueAttachmentScan } from './attachment.processor';
import { readAttachmentStream } from './attachment-stream';

interface Actor {
  id: string;
  role: string;
}

interface CurrentFeatureRow {
  featureId: string;
  versionId: string;
  geometry: Record<string, unknown>;
  geometryKind: string;
  properties: Record<string, unknown>;
  radiusM: number | null;
  externalSource: string | null;
  externalId: string | null;
}

interface AttachmentLinkRow {
  id: string;
  fieldKey: string;
  displayOrder: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: AttachmentStatus;
}

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
    private readonly retention: ChangeFeedRetentionService,
    @InjectQueue(ATTACHMENT_QUEUE) private readonly queue: Queue,
  ) {}

  async createUpload(dto: CreateAttachmentUploadDto, actor: Actor) {
    const file = validateDeclaredAttachment(dto);
    const id = randomUUID();
    const nonce = randomUUID();
    const quarantineKey = `quarantine/attachments/${actor.id}/${id}/${nonce}`;
    const ttl = this.config.getOrThrow<number>('attachments.uploadTtlSeconds');
    const expiresAt = new Date(Date.now() + ttl * 1_000);
    await this.dataSource.query(
      `INSERT INTO attachments(
         id,purpose,quarantine_key,object_key,file_name,declared_content_type,
         declared_size_bytes,declared_sha256,status,owner_id,upload_expires_at
       ) VALUES($1,'feature_attachment',$2,NULL,$3,$4,$5,$6,'uploading',$7,$8)`,
      [
        id,
        quarantineKey,
        file.fileName,
        file.contentType,
        dto.sizeBytes,
        dto.sha256,
        actor.id,
        expiresAt,
      ],
    );
    try {
      const url = await this.storage.presignedPut(quarantineKey, ttl);
      return {
        uploadId: id,
        attachmentId: id,
        status: 'uploading' as const,
        file: {
          name: file.fileName,
          contentType: file.contentType,
          sizeBytes: dto.sizeBytes,
          sha256: dto.sha256,
        },
        upload: {
          method: 'PUT' as const,
          url,
          headers: { 'Content-Type': file.contentType },
          expiresAt: expiresAt.toISOString(),
        },
      };
    } catch (error) {
      await this.dataSource.query("DELETE FROM attachments WHERE id=$1 AND status='uploading'", [
        id,
      ]);
      throw error;
    }
  }

  async complete(uploadId: string, actor: Actor) {
    const attachment = await this.owned(uploadId, actor.id);
    if (attachment.status !== 'uploading') return this.metadata(attachment);
    if (attachment.uploadExpiresAt.getTime() < Date.now()) {
      await this.rejectFinalize(attachment, 'ATTACHMENT_UPLOAD_EXPIRED');
      throw new AppException(422, 'ATTACHMENT_UPLOAD_EXPIRED', 'Phiên tải tệp đã hết hạn.');
    }
    try {
      const stat = await this.storage.stat(attachment.quarantineKey).catch(() => {
        throw new AppException(
          422,
          'ATTACHMENT_UPLOAD_INCOMPLETE',
          'Object upload chưa sẵn sàng để hoàn tất.',
        );
      });
      const storedContentType = normalizeContentType(
        String(stat.metaData?.['content-type'] ?? stat.metaData?.['Content-Type'] ?? ''),
      );
      if (Number(stat.size) !== attachment.declaredSizeBytes) {
        throw new AppException(
          422,
          'ATTACHMENT_SIZE_MISMATCH',
          'Kích thước tệp không khớp upload intent.',
        );
      }
      if (storedContentType !== attachment.declaredContentType) {
        throw new AppException(
          422,
          'ATTACHMENT_MIME_MISMATCH',
          'MIME của object không khớp upload intent.',
        );
      }
      const content = await readAttachmentStream(
        await this.storage.getObject(attachment.quarantineKey),
      );
      validateAttachmentBytes(content, attachment.declaredContentType);
      const sha256 = createHash('sha256').update(content).digest('hex');
      if (sha256 !== attachment.declaredSha256) {
        throw new AppException(
          422,
          'ATTACHMENT_CHECKSUM_MISMATCH',
          'Checksum tệp không khớp upload intent.',
        );
      }
      const rows = (await this.dataSource.query(
        `UPDATE attachments SET status='pending',content_type=declared_content_type,
                size_bytes=declared_size_bytes,sha256=declared_sha256,finalized_at=now(),updated_at=now()
         WHERE id=$1 AND owner_id=$2 AND status='uploading'
         RETURNING id`,
        [uploadId, actor.id],
      )) as Array<{ id: string }>;
      if (!rows[0]) return this.get(uploadId);
      await enqueueAttachmentScan(this.queue, uploadId).catch(() => undefined);
      return this.get(uploadId);
    } catch (error) {
      if (error instanceof AppException && error.code !== 'ATTACHMENT_UPLOAD_INCOMPLETE') {
        await this.rejectFinalize(attachment, error.code);
      }
      throw error;
    }
  }

  async get(attachmentId: string) {
    const attachment = await this.dataSource
      .getRepository(AttachmentEntity)
      .findOneBy({ id: attachmentId });
    if (!attachment || attachment.status === 'deleted') {
      throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy tệp đính kèm.');
    }
    return this.metadata(attachment);
  }

  async deleteUnbound(attachmentId: string, actor: Actor) {
    const attachment = await this.owned(attachmentId, actor.id);
    const rows = (await this.dataSource.query(
      `UPDATE attachments attachment SET status='deleted',deleted_at=now(),updated_at=now()
       WHERE attachment.id=$1 AND attachment.owner_id=$2 AND attachment.status<>'deleted'
         AND NOT EXISTS (
           SELECT 1 FROM feature_version_attachments link WHERE link.attachment_id=attachment.id
         ) RETURNING attachment.id`,
      [attachmentId, actor.id],
    )) as Array<{ id: string }>;
    if (!rows.length) {
      throw new AppException(
        409,
        'ATTACHMENT_ALREADY_BOUND',
        'Tệp đã thuộc lịch sử feature và không thể xóa trực tiếp.',
      );
    }
    await Promise.all([
      this.storage.removeIfPresent(attachment.quarantineKey),
      this.storage.removeIfPresent(attachment.objectKey),
    ]).catch(() => undefined);
    return { id: attachmentId, status: 'deleted' as const };
  }

  bind(
    revisionId: string,
    featureId: string,
    dto: BindAttachmentDto,
    ifMatch: string | undefined,
    idempotencyKey: string,
    actor: Actor,
    requestId: string,
  ) {
    return this.mutateLinks({
      operation: 'attachment.bind',
      revisionId,
      featureId,
      ifMatch,
      idempotencyKey,
      actor,
      requestId,
      digestInput: dto,
      mutate: async (manager, current, links) => {
        const field = await this.attachmentField(manager, revisionId, dto.fieldKey);
        const attachment = await this.cleanOwned(manager, dto.attachmentId, actor.id);
        if (field.type === 'image' && !attachment.contentType?.startsWith('image/')) {
          throw new AppException(422, 'SCHEMA_VIOLATION', 'Field image chỉ nhận tệp hình ảnh.');
        }
        if (links.some((link) => link.id === dto.attachmentId)) {
          throw new AppException(409, 'ATTACHMENT_ALREADY_BOUND', 'Tệp đã được bind vào feature.');
        }
        const otherFeature = (await manager.query(
          `SELECT 1 FROM feature_version_attachments link
           JOIN feature_versions version ON version.id=link.feature_version_id
           WHERE link.attachment_id=$1 AND version.feature_id<>$2 LIMIT 1`,
          [dto.attachmentId, featureId],
        )) as unknown[];
        if (otherFeature.length) {
          throw new AppException(
            409,
            'ATTACHMENT_OWNERSHIP_CONFLICT',
            'Tệp đã thuộc một feature khác.',
          );
        }
        return [
          ...links,
          {
            id: attachment.id,
            fieldKey: dto.fieldKey,
            displayOrder: dto.displayOrder,
            fileName: attachment.fileName,
            contentType: attachment.contentType!,
            sizeBytes: attachment.sizeBytes!,
            status: attachment.status,
          },
        ];
      },
    });
  }

  reorder(
    revisionId: string,
    featureId: string,
    fieldKey: string,
    attachmentIds: string[],
    ifMatch: string | undefined,
    idempotencyKey: string,
    actor: Actor,
    requestId: string,
  ) {
    return this.mutateLinks({
      operation: 'attachment.reorder',
      revisionId,
      featureId,
      ifMatch,
      idempotencyKey,
      actor,
      requestId,
      digestInput: { fieldKey, attachmentIds },
      mutate: async (manager, _current, links) => {
        await this.attachmentField(manager, revisionId, fieldKey);
        const fieldLinks = links.filter((link) => link.fieldKey === fieldKey);
        if (
          fieldLinks.length !== attachmentIds.length ||
          fieldLinks.some((link) => !attachmentIds.includes(link.id))
        ) {
          throw new AppException(
            422,
            'ATTACHMENT_ORDER_INVALID',
            'Danh sách sắp xếp phải chứa đúng các tệp hiện có của field.',
          );
        }
        const order = new Map(attachmentIds.map((id, index) => [id, index * 10]));
        return links.map((link) =>
          link.fieldKey === fieldKey ? { ...link, displayOrder: order.get(link.id)! } : link,
        );
      },
    });
  }

  unbind(
    revisionId: string,
    featureId: string,
    attachmentId: string,
    ifMatch: string | undefined,
    idempotencyKey: string,
    actor: Actor,
    requestId: string,
  ) {
    return this.mutateLinks({
      operation: 'attachment.unbind',
      revisionId,
      featureId,
      ifMatch,
      idempotencyKey,
      actor,
      requestId,
      digestInput: { attachmentId },
      mutate: (_manager, _current, links) => {
        if (!links.some((link) => link.id === attachmentId)) {
          throw new AppException(404, 'NOT_FOUND', 'Tệp không thuộc feature version hiện tại.');
        }
        return links.filter((link) => link.id !== attachmentId);
      },
    });
  }

  async publicObject(attachmentId: string) {
    const rows = (await this.dataSource.query(
      `SELECT attachment.object_key AS "objectKey",attachment.file_name AS "fileName",
              attachment.content_type AS "contentType",attachment.size_bytes AS "sizeBytes",
              attachment.sha256
       FROM layer_publications pointer
       JOIN publication_snapshots snapshot
         ON snapshot.id=pointer.active_snapshot_id AND snapshot.status='published'
       JOIN revision_features member ON member.revision_id=snapshot.revision_id
       JOIN feature_version_attachments link ON link.feature_version_id=member.feature_version_id
       JOIN attachments attachment ON attachment.id=link.attachment_id AND attachment.status='clean'
       JOIN layer_fields field ON field.revision_id=snapshot.revision_id AND field.key=link.field_key
         AND field.public=true AND field.sensitive=false AND field.type IN ('image','attachment')
       WHERE attachment.id=$1 AND attachment.object_key IS NOT NULL
       LIMIT 1`,
      [attachmentId],
    )) as Array<{
      objectKey: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    }>;
    const row = rows[0];
    if (!row) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy tệp công khai.');
    return { ...row, stream: await this.storage.getObject(row.objectKey) };
  }

  async publicLinksForVersion(versionId: string, revisionId: string): Promise<AttachmentLinkRow[]> {
    return (await this.dataSource.query(
      `SELECT attachment.id,link.field_key AS "fieldKey",link.display_order AS "displayOrder",
              attachment.file_name AS "fileName",attachment.content_type AS "contentType",
              attachment.size_bytes AS "sizeBytes",attachment.status
       FROM feature_version_attachments link
       JOIN attachments attachment ON attachment.id=link.attachment_id AND attachment.status='clean'
       JOIN layer_fields field ON field.revision_id=$2 AND field.key=link.field_key
         AND field.public=true AND field.sensitive=false AND field.type IN ('image','attachment')
       WHERE link.feature_version_id=$1
       ORDER BY link.field_key,link.display_order,attachment.id`,
      [versionId, revisionId],
    )) as AttachmentLinkRow[];
  }

  private async mutateLinks(input: {
    operation: string;
    revisionId: string;
    featureId: string;
    ifMatch: string | undefined;
    idempotencyKey: string;
    actor: Actor;
    requestId: string;
    digestInput: unknown;
    mutate: (
      manager: EntityManager,
      current: CurrentFeatureRow,
      links: AttachmentLinkRow[],
    ) => Promise<AttachmentLinkRow[]> | AttachmentLinkRow[];
  }) {
    const expectedVersion = requireRevisionVersion(input.ifMatch, input.revisionId);
    const digest = this.idempotency.digest({
      revisionId: input.revisionId,
      featureId: input.featureId,
      ifMatch: input.ifMatch,
      body: input.digestInput,
    });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        input.actor.id,
        input.operation,
        input.idempotencyKey,
        digest,
      );
      if (!receipt.owner) {
        if (receipt.response) return receipt.response;
        throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
      }
      const locked = await this.lockRevision(manager, input.revisionId, expectedVersion);
      const current = await this.currentFeature(manager, input.revisionId, input.featureId);
      const links = await this.versionLinks(manager, current.versionId);
      const nextLinks = await input.mutate(manager, current, links);
      this.assertLinkLimits(nextLinks);
      const properties = await this.materializeAttachmentProperties(
        manager,
        input.revisionId,
        current.properties,
        nextLinks,
      );
      const checksum = this.versionChecksum(current, properties, nextLinks);
      const versions = (await manager.query(
        `INSERT INTO feature_versions(
           feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by
         ) SELECT feature_id,revision_id,geometry,geometry_kind,$2::jsonb,radius_m,$3,$4
           FROM feature_versions WHERE id=$1 RETURNING id,created_at`,
        [current.versionId, JSON.stringify(properties), checksum, input.actor.id],
      )) as Array<{ id: string; created_at: Date }>;
      const version = versions[0]!;
      for (const link of nextLinks) {
        await manager.query(
          `INSERT INTO feature_version_attachments(
             feature_version_id,attachment_id,field_key,display_order
           ) VALUES($1,$2,$3,$4)`,
          [version.id, link.id, link.fieldKey, link.displayOrder],
        );
      }
      await manager.query(
        `UPDATE revision_features SET feature_version_id=$3 WHERE revision_id=$1 AND feature_id=$2`,
        [input.revisionId, input.featureId, version.id],
      );
      const changedFields = [...new Set([...links, ...nextLinks].map((link) => link.fieldKey))];
      await manager.query(
        `INSERT INTO revision_changes(
           revision_id,server_cursor,operation,feature_id,version_id,changed_paths,actor_id
         ) VALUES($1,$2,'update',$3,$4,$5,$6)`,
        [
          input.revisionId,
          String(locked.cursorSeq),
          input.featureId,
          version.id,
          changedFields.map((field) => `attachments.${field}`),
          input.actor.id,
        ],
      );
      await this.retention.prune(manager, input.revisionId, locked.cursorSeq);
      await manager.query(
        `INSERT INTO revision_participants(revision_id,user_id,participation_type)
         VALUES($1,$2,'edit') ON CONFLICT DO NOTHING`,
        [input.revisionId, input.actor.id],
      );
      await manager.query(
        `INSERT INTO audit_logs(
           actor_id,actor_role,action,resource_type,resource_id,request_id,metadata
         ) VALUES($1,$2,$3,'feature',$4,$5,$6::jsonb)`,
        [
          input.actor.id,
          input.actor.role,
          input.operation,
          input.featureId,
          input.requestId,
          JSON.stringify({
            revisionId: input.revisionId,
            previousVersionId: current.versionId,
            versionId: version.id,
            attachmentCount: nextLinks.length,
          }),
        ],
      );
      const response = {
        feature: {
          type: 'Feature',
          id: current.featureId,
          geometry: current.geometry,
          properties,
          attachments: nextLinks.map((link) => this.linkDto(link, false)),
          meta: {
            geometryKind: current.geometryKind,
            radiusM: current.radiusM,
            externalSource: current.externalSource,
            externalId: current.externalId,
            versionId: version.id,
            updatedAt: version.created_at.toISOString(),
          },
        },
        serverCursor: Buffer.from(String(locked.cursorSeq)).toString('base64url'),
        etag: revisionEtag(input.revisionId, locked.lockVersion),
      };
      await this.idempotency.complete(
        manager,
        input.actor.id,
        input.operation,
        input.idempotencyKey,
        response,
        200,
        response.etag,
      );
      return response;
    });
  }

  private async lockRevision(manager: EntityManager, revisionId: string, expectedVersion: number) {
    const rows = (await manager.query(
      `SELECT status,lock_version AS "lockVersion",cursor_seq AS "cursorSeq"
       FROM layer_revisions WHERE id=$1 FOR UPDATE`,
      [revisionId],
    )) as Array<{ status: string; lockVersion: number; cursorSeq: string }>;
    const revision = rows[0];
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    if (revision.status !== 'draft') {
      throw new AppException(409, 'REVISION_NOT_EDITABLE', 'Revision không ở trạng thái draft.');
    }
    if (revision.lockVersion !== expectedVersion) {
      throw new AppException(412, 'ETAG_MISMATCH', 'Phiên bản dữ liệu đã thay đổi.', {
        currentEtag: revisionEtag(revisionId, revision.lockVersion),
      });
    }
    const lockVersion = revision.lockVersion + 1;
    const cursorSeq = Number(revision.cursorSeq) + 1;
    await manager.query(
      `UPDATE layer_revisions SET lock_version=$2,cursor_seq=$3,updated_at=now() WHERE id=$1`,
      [revisionId, lockVersion, cursorSeq],
    );
    return { lockVersion, cursorSeq };
  }

  private async currentFeature(
    manager: EntityManager,
    revisionId: string,
    featureId: string,
  ): Promise<CurrentFeatureRow> {
    const rows = (await manager.query(
      `SELECT feature.id AS "featureId",version.id AS "versionId",
              ST_AsGeoJSON(version.geometry)::jsonb AS geometry,
              version.geometry_kind AS "geometryKind",version.properties,
              version.radius_m AS "radiusM",feature.external_source AS "externalSource",
              feature.external_id AS "externalId"
       FROM revision_features member
       JOIN features feature ON feature.id=member.feature_id
       JOIN feature_versions version ON version.id=member.feature_version_id
       WHERE member.revision_id=$1 AND member.feature_id=$2
       FOR UPDATE OF member`,
      [revisionId, featureId],
    )) as CurrentFeatureRow[];
    const row = rows[0];
    if (!row) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy feature.');
    return row;
  }

  private async versionLinks(
    manager: EntityManager,
    versionId: string,
  ): Promise<AttachmentLinkRow[]> {
    return (await manager.query(
      `SELECT attachment.id,link.field_key AS "fieldKey",link.display_order AS "displayOrder",
              attachment.file_name AS "fileName",attachment.content_type AS "contentType",
              attachment.size_bytes AS "sizeBytes",attachment.status
       FROM feature_version_attachments link
       JOIN attachments attachment ON attachment.id=link.attachment_id
       WHERE link.feature_version_id=$1
       ORDER BY link.field_key,link.display_order,attachment.id`,
      [versionId],
    )) as AttachmentLinkRow[];
  }

  private async attachmentField(manager: EntityManager, revisionId: string, fieldKey: string) {
    const rows = (await manager.query(
      `SELECT type,public,sensitive FROM layer_fields
       WHERE revision_id=$1 AND key=$2 AND type IN ('image','attachment')`,
      [revisionId, fieldKey],
    )) as Array<{ type: 'image' | 'attachment'; public: boolean; sensitive: boolean }>;
    const field = rows[0];
    if (!field) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'Field không nhận tệp đính kèm.');
    }
    return field;
  }

  private async cleanOwned(manager: EntityManager, attachmentId: string, ownerId: string) {
    const attachment = await manager.getRepository(AttachmentEntity).findOne({
      where: { id: attachmentId, ownerId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!attachment) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy tệp đính kèm.');
    if (
      attachment.status !== 'clean' ||
      !attachment.objectKey ||
      !attachment.contentType ||
      !attachment.sizeBytes
    ) {
      throw new AppException(409, 'ATTACHMENT_NOT_READY', 'Tệp chưa sẵn sàng để bind.');
    }
    return attachment;
  }

  private async materializeAttachmentProperties(
    manager: EntityManager,
    revisionId: string,
    current: Record<string, unknown>,
    links: AttachmentLinkRow[],
  ): Promise<Record<string, unknown>> {
    const fields = (await manager.query(
      `SELECT key FROM layer_fields WHERE revision_id=$1 AND type IN ('image','attachment')`,
      [revisionId],
    )) as Array<{ key: string }>;
    const result = structuredClone(current);
    for (const { key } of fields) {
      result[key] = links
        .filter((link) => link.fieldKey === key)
        .sort(
          (left, right) =>
            left.displayOrder - right.displayOrder || left.id.localeCompare(right.id),
        )
        .map((link) => link.id);
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 64 * 1024) {
      throw new AppException(422, 'RESOURCE_LIMIT_EXCEEDED', 'Properties vượt quá 64 KiB.');
    }
    return result;
  }

  private versionChecksum(
    current: CurrentFeatureRow,
    properties: Record<string, unknown>,
    links: AttachmentLinkRow[],
  ): string {
    return this.crypto.checksum(
      JSON.stringify({
        geometry: current.geometry,
        properties: this.canonical(properties),
        radiusM: current.radiusM,
        attachments: links
          .map((link) => ({
            id: link.id,
            fieldKey: link.fieldKey,
            displayOrder: link.displayOrder,
          }))
          .sort(
            (left, right) =>
              left.fieldKey.localeCompare(right.fieldKey) ||
              left.displayOrder - right.displayOrder ||
              left.id.localeCompare(right.id),
          ),
      }),
    );
  }

  private canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonical(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, this.canonical(item)]),
      );
    }
    return value;
  }

  private assertLinkLimits(links: AttachmentLinkRow[]): void {
    const counts = new Map<string, number>();
    for (const link of links) counts.set(link.fieldKey, (counts.get(link.fieldKey) ?? 0) + 1);
    if (links.length > 500 || [...counts.values()].some((count) => count > 100)) {
      throw new AppException(
        422,
        'RESOURCE_LIMIT_EXCEEDED',
        'Vượt giới hạn 100 tệp mỗi field hoặc 500 tệp mỗi feature.',
      );
    }
  }

  private async owned(attachmentId: string, ownerId: string): Promise<AttachmentEntity> {
    const row = await this.dataSource
      .getRepository(AttachmentEntity)
      .findOneBy({ id: attachmentId, ownerId });
    if (!row || row.status === 'deleted') {
      throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy tệp đính kèm.');
    }
    return row;
  }

  private metadata(input: AttachmentEntity) {
    const attachment = input;
    return {
      id: attachment.id,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      sha256: attachment.sha256,
      status: attachment.status,
      ownerId: attachment.ownerId,
      rejectionCode: attachment.rejectionCode,
      finalizedAt: attachment.finalizedAt?.toISOString() ?? null,
      scannedAt: attachment.scannedAt?.toISOString() ?? null,
      createdAt: attachment.createdAt.toISOString(),
      updatedAt: attachment.updatedAt.toISOString(),
    };
  }

  private linkDto(link: AttachmentLinkRow, isPublic: boolean) {
    return {
      id: link.id,
      fieldKey: link.fieldKey,
      displayOrder: Number(link.displayOrder),
      fileName: link.fileName,
      contentType: link.contentType,
      sizeBytes: Number(link.sizeBytes),
      status: link.status,
      url: isPublic ? `/api/v1/public/attachments/${link.id}` : null,
    };
  }

  public publicLinkDto(link: AttachmentLinkRow) {
    return this.linkDto(link, true);
  }

  private async rejectFinalize(attachment: AttachmentEntity, code: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE attachments SET status='rejected',rejection_code=$2,updated_at=now()
       WHERE id=$1 AND status='uploading'`,
      [attachment.id, code],
    );
    await this.storage.removeIfPresent(attachment.quarantineKey).catch(() => undefined);
  }
}
