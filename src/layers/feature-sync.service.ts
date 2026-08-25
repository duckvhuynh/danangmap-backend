import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import type { GeometryKind } from '../domain/enums';
import type {
  FeatureBatchSyncDto,
  FeatureMutationDto,
  FeatureSyncMutationDto,
  FeatureSyncPatchDto,
  LayerFieldDto,
} from './layer.dto';
import { cursorDecode, cursorEncode, requireRevisionVersion, revisionEtag } from './etag';
import { GeometryService } from './geometry.service';
import { LayerFieldEntity } from './layer.entities';
import { LayerSchemaService } from './layer-schema.service';
import { RevisionParticipantEntity } from '../workflow/workflow.entities';
import { ChangeFeedRetentionService } from './change-feed-retention.service';

interface Actor {
  id: string;
  role: string;
}

interface LockedRevision {
  id: string;
  layer_id: string;
  status: string;
  allowed_geometry_kinds: GeometryKind[];
  lock_version: number;
  cursor_seq: string;
  change_cursor_floor: string;
}

interface MutationReceiptRow {
  mutation_id: string;
  request_digest: string;
  response_payload: FeatureSyncResult;
  server_cursor: string;
  client_feature_id: string | null;
  canonical_feature_id: string | null;
}

interface CurrentFeatureRow {
  id: string;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
  geometry_kind: GeometryKind;
  radius_m: number | null;
  external_source: string | null;
  external_id: string | null;
  version_id: string;
}

interface FeatureAttachmentRow {
  id: string;
  field_key: string;
  display_order: number;
}

export type FeatureSyncResult =
  | {
      clientMutationId: string;
      status: 'applied';
      operation: 'create' | 'update' | 'delete';
      clientFeatureId: string | null;
      canonicalFeatureId: string;
      versionId: string | null;
      serverCursor: string;
    }
  | {
      clientMutationId: string;
      status: 'conflict';
      operation: 'update' | 'delete';
      canonicalFeatureId: string;
      serverCursor: string;
      conflict: {
        code: 'FEATURE_VERSION_CHANGED';
        currentVersionId: string;
        changedPaths: string[];
      };
    }
  | {
      clientMutationId: string;
      status: 'rejected';
      operation: 'create' | 'update' | 'delete';
      canonicalFeatureId: string | null;
      serverCursor: string;
      error: { code: string; message: string; details: Record<string, unknown> };
    };

@Injectable()
export class FeatureSyncService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly geometry: GeometryService,
    private readonly schema: LayerSchemaService,
    private readonly crypto: CryptoService,
    private readonly retention: ChangeFeedRetentionService,
  ) {}

  async syncBatch(
    revisionId: string,
    dto: FeatureBatchSyncDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
  ) {
    const expectedRevisionVersion = requireRevisionVersion(ifMatch, revisionId);
    const baseCursor = cursorDecode(dto.baseCursor);
    const prepared = dto.mutations.map((mutation) => ({
      mutation,
      calculatedHash: this.mutationPayloadHash(mutation),
    }));

    return this.dataSource.transaction(async (manager) => {
      const revision = await this.lockRevision(manager, revisionId);
      const receipts = await this.loadReceipts(
        manager,
        revisionId,
        dto.clientId,
        dto.mutations.map((mutation) => mutation.clientMutationId),
      );

      for (const item of prepared) {
        const receipt = receipts.get(item.mutation.clientMutationId);
        if (receipt && receipt.request_digest !== item.calculatedHash) {
          throw new AppException(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'clientMutationId đã được dùng với payload khác.',
          );
        }
        if (item.mutation.payloadHash !== item.calculatedHash) {
          throw new AppException(
            422,
            'SYNC_PAYLOAD_HASH_MISMATCH',
            'payloadHash không khớp payload.',
          );
        }
      }

      const newMutations = prepared.filter(
        ({ mutation }) => !receipts.has(mutation.clientMutationId),
      );
      if (newMutations.length) {
        this.assertBatchPreconditions(
          revisionId,
          revision,
          expectedRevisionVersion,
          baseCursor,
          newMutations.map(({ mutation }) => mutation),
        );
      }

      const fields = newMutations.length
        ? await manager.findBy(LayerFieldEntity, { revisionId })
        : [];
      const clientMappings = await this.loadClientMappings(manager, revisionId, dto.clientId);
      let cursor = Number(revision.cursor_seq);
      let appliedCount = 0;
      const results: FeatureSyncResult[] = [];

      for (const [index, item] of prepared.entries()) {
        const existing = receipts.get(item.mutation.clientMutationId);
        if (existing) {
          results.push(existing.response_payload);
          if (existing.client_feature_id && existing.canonical_feature_id) {
            clientMappings.set(existing.client_feature_id, existing.canonical_feature_id);
          }
          continue;
        }

        const savepoint = `feature_sync_${index}`;
        await manager.query(`SAVEPOINT ${savepoint}`);
        let result: FeatureSyncResult;
        try {
          const applied = await this.applyMutation(
            manager,
            revision,
            fields as unknown as LayerFieldDto[],
            dto.clientId,
            dto.origin,
            item.mutation,
            clientMappings,
            cursor + 1,
            actor,
            requestId,
          );
          result = applied.result;
          if (applied.applied) {
            cursor += 1;
            appliedCount += 1;
          }
          await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (error) {
          await manager.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await manager.query(`RELEASE SAVEPOINT ${savepoint}`);
          result = this.rejectedResult(item.mutation, error, cursor);
        }

        await this.persistReceipt(
          manager,
          revisionId,
          dto.clientId,
          item.mutation,
          item.calculatedHash,
          result,
          cursor,
        );
        if (result.status === 'applied' && result.clientFeatureId && result.canonicalFeatureId) {
          clientMappings.set(result.clientFeatureId, result.canonicalFeatureId);
        }
        results.push(result);
      }

      let lockVersion = revision.lock_version;
      if (appliedCount > 0) {
        lockVersion += appliedCount;
        await manager.query(
          `UPDATE layer_revisions
           SET lock_version=$2,cursor_seq=$3,updated_at=now()
           WHERE id=$1`,
          [revisionId, lockVersion, cursor],
        );
        await this.retention.prune(manager, revisionId, cursor);
        await manager
          .createQueryBuilder()
          .insert()
          .into(RevisionParticipantEntity)
          .values({ revisionId, userId: actor.id, participationType: 'edit' })
          .orIgnore()
          .execute();
      }

      if (newMutations.length) {
        const counts = results.reduce<Record<string, number>>((accumulator, result) => {
          accumulator[result.status] = (accumulator[result.status] ?? 0) + 1;
          return accumulator;
        }, {});
        await this.insertAudit(manager, actor, requestId, 'feature.batch_synced', revisionId, {
          origin: dto.origin,
          clientId: dto.clientId,
          mutationCount: newMutations.length,
          counts,
          mutationDigest: this.crypto.checksum(
            JSON.stringify(newMutations.map(({ mutation }) => mutation.clientMutationId).sort()),
          ),
        });
      }

      return {
        data: {
          revisionId,
          serverCursor: cursorEncode(cursor),
          results,
        },
        etag: revisionEtag(revisionId, lockVersion),
      };
    });
  }

  async changes(revisionId: string, afterValue: string, limit: number) {
    const after = cursorDecode(afterValue);
    const revisionRows = (await this.dataSource.query(
      `SELECT id,lock_version,cursor_seq,change_cursor_floor
       FROM layer_revisions WHERE id=$1`,
      [revisionId],
    )) as Array<{
      id: string;
      lock_version: number;
      cursor_seq: string;
      change_cursor_floor: string;
    }>;
    const revision = revisionRows[0];
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    const cursorFloor = Number(revision.change_cursor_floor);
    const currentCursor = Number(revision.cursor_seq);
    const etag = revisionEtag(revisionId, revision.lock_version);
    if (after < cursorFloor) {
      throw new AppException(409, 'SYNC_CURSOR_EXPIRED', 'Change cursor đã hết thời hạn lưu.', {
        workspaceUrl: `/api/v1/admin/revisions/${revisionId}/workspace`,
        currentEtag: etag,
        currentCursor: cursorEncode(currentCursor),
      });
    }
    if (after > currentCursor) {
      throw new AppException(400, 'VALIDATION_FAILED', 'Cursor nằm trước trạng thái máy chủ.');
    }
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const rows = (await this.dataSource.query(
      `SELECT change.server_cursor,change.operation,change.feature_id,change.version_id,
              change.changed_paths,change.changed_at,user_account.id AS actor_id,
              user_account.display_name AS actor_display_name
       FROM revision_changes change
       JOIN users user_account ON user_account.id=change.actor_id
       WHERE change.revision_id=$1 AND change.server_cursor > $2
       ORDER BY change.server_cursor ASC
       LIMIT $3`,
      [revisionId, after, boundedLimit + 1],
    )) as Array<{
      server_cursor: string;
      operation: 'create' | 'update' | 'delete';
      feature_id: string;
      version_id: string | null;
      changed_paths: string[];
      changed_at: Date;
      actor_id: string;
      actor_display_name: string;
    }>;
    const hasMore = rows.length > boundedLimit;
    const page = hasMore ? rows.slice(0, boundedLimit) : rows;
    const nextCursor = page.length ? cursorEncode(page.at(-1)!.server_cursor) : cursorEncode(after);
    return {
      data: page.map((row) => ({
        serverCursor: cursorEncode(row.server_cursor),
        operation: row.operation,
        featureId: row.feature_id,
        versionId: row.version_id,
        changedPaths: row.changed_paths,
        actor: { id: row.actor_id, displayName: row.actor_display_name },
        changedAt: row.changed_at.toISOString(),
      })),
      meta: { nextCursor, hasMore, limit: boundedLimit },
      etag,
    };
  }

  private assertBatchPreconditions(
    revisionId: string,
    revision: LockedRevision,
    expectedRevisionVersion: number,
    baseCursor: number,
    mutations: FeatureSyncMutationDto[],
  ): void {
    if (revision.status !== 'draft') {
      throw new AppException(409, 'REVISION_NOT_EDITABLE', 'Revision không ở trạng thái draft.');
    }
    if (revision.lock_version !== expectedRevisionVersion) {
      throw new AppException(412, 'ETAG_MISMATCH', 'Phiên bản dữ liệu đã thay đổi.', {
        currentEtag: revisionEtag(revisionId, revision.lock_version),
      });
    }
    if (mutations.some((mutation) => mutation.baseRevisionVersion !== expectedRevisionVersion)) {
      throw new AppException(
        422,
        'SYNC_BASE_REVISION_MISMATCH',
        'baseRevisionVersion phải khớp If-Match của batch.',
      );
    }
    const cursorFloor = Number(revision.change_cursor_floor);
    const currentCursor = Number(revision.cursor_seq);
    if (baseCursor < cursorFloor) {
      throw new AppException(409, 'SYNC_CURSOR_EXPIRED', 'Change cursor đã hết thời hạn lưu.', {
        workspaceUrl: `/api/v1/admin/revisions/${revisionId}/workspace`,
        currentEtag: revisionEtag(revisionId, revision.lock_version),
        currentCursor: cursorEncode(currentCursor),
      });
    }
    if (baseCursor > currentCursor) {
      throw new AppException(422, 'SYNC_BASE_CURSOR_INVALID', 'baseCursor mới hơn máy chủ.');
    }
  }

  private async applyMutation(
    manager: EntityManager,
    revision: LockedRevision,
    fields: LayerFieldDto[],
    clientId: string,
    origin: 'editor' | 'recovery',
    mutation: FeatureSyncMutationDto,
    clientMappings: Map<string, string>,
    nextCursor: number,
    actor: Actor,
    requestId: string,
  ): Promise<{ applied: boolean; result: FeatureSyncResult }> {
    if (mutation.operation === 'create') {
      return this.applyCreate(
        manager,
        revision,
        fields,
        clientId,
        origin,
        mutation,
        clientMappings,
        nextCursor,
        actor,
        requestId,
      );
    }
    return this.applyUpdateOrDelete(
      manager,
      revision,
      fields,
      origin,
      mutation,
      clientMappings,
      nextCursor,
      actor,
      requestId,
    );
  }

  private async applyCreate(
    manager: EntityManager,
    revision: LockedRevision,
    fields: LayerFieldDto[],
    clientId: string,
    origin: 'editor' | 'recovery',
    mutation: FeatureSyncMutationDto,
    clientMappings: Map<string, string>,
    nextCursor: number,
    actor: Actor,
    requestId: string,
  ): Promise<{ applied: true; result: FeatureSyncResult }> {
    if (
      !mutation.clientFeatureId ||
      !mutation.feature ||
      mutation.featureId ||
      mutation.baseVersionId
    ) {
      throw new AppException(
        422,
        'SCHEMA_VIOLATION',
        'Create cần clientFeatureId + feature và không nhận featureId/baseVersionId.',
      );
    }
    if (clientMappings.has(mutation.clientFeatureId)) {
      throw new AppException(
        409,
        'CLIENT_FEATURE_ID_REUSED',
        'clientFeatureId đã được ánh xạ bởi mutation khác.',
      );
    }
    await this.validateFeature(revision, fields, mutation.feature, false);
    const featureRows = (await manager.query(
      `INSERT INTO features(layer_id,external_source,external_id)
       VALUES($1,$2,$3) RETURNING id`,
      [
        revision.layer_id,
        mutation.feature.externalSource ?? null,
        mutation.feature.externalId ?? null,
      ],
    )) as Array<{ id: string }>;
    const featureId = featureRows[0]!.id;
    const versionId = await this.insertVersion(
      manager,
      revision.id,
      featureId,
      mutation.feature.geometry,
      mutation.feature.geometryKind,
      mutation.feature.properties,
      mutation.feature.radiusM ?? null,
      actor.id,
    );
    await manager.query(
      `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
       SELECT $1,$2,$3,COALESCE(max(ordinal)+1,0) FROM revision_features WHERE revision_id=$1`,
      [revision.id, featureId, versionId],
    );
    await this.insertChange(
      manager,
      revision.id,
      nextCursor,
      'create',
      featureId,
      versionId,
      ['geometry', 'properties'],
      actor.id,
    );
    await this.insertFeatureAudit(manager, actor, requestId, 'feature.created', featureId, {
      revisionId: revision.id,
      origin,
      clientId,
      clientMutationId: mutation.clientMutationId,
    });
    return {
      applied: true,
      result: {
        clientMutationId: mutation.clientMutationId,
        status: 'applied',
        operation: 'create',
        clientFeatureId: mutation.clientFeatureId,
        canonicalFeatureId: featureId,
        versionId,
        serverCursor: cursorEncode(nextCursor),
      },
    };
  }

  private async applyUpdateOrDelete(
    manager: EntityManager,
    revision: LockedRevision,
    fields: LayerFieldDto[],
    origin: 'editor' | 'recovery',
    mutation: FeatureSyncMutationDto,
    clientMappings: Map<string, string>,
    nextCursor: number,
    actor: Actor,
    requestId: string,
  ): Promise<{ applied: boolean; result: FeatureSyncResult }> {
    if (
      !mutation.baseVersionId ||
      Boolean(mutation.featureId) === Boolean(mutation.clientFeatureId)
    ) {
      throw new AppException(
        422,
        'SCHEMA_VIOLATION',
        'Update/delete cần baseVersionId và đúng một featureId hoặc clientFeatureId.',
      );
    }
    const featureId = mutation.featureId ?? clientMappings.get(mutation.clientFeatureId ?? '');
    if (!featureId) {
      throw new AppException(
        409,
        'CLIENT_FEATURE_MAPPING_NOT_FOUND',
        'Chưa có mapping server cho clientFeatureId.',
      );
    }
    const current = await this.currentFeature(manager, revision.id, featureId);
    if (!current) throw new AppException(404, 'FEATURE_NOT_FOUND', 'Không tìm thấy feature.');
    if (current.version_id !== mutation.baseVersionId) {
      return {
        applied: false,
        result: {
          clientMutationId: mutation.clientMutationId,
          status: 'conflict',
          operation: mutation.operation as 'update' | 'delete',
          canonicalFeatureId: featureId,
          serverCursor: cursorEncode(nextCursor - 1),
          conflict: {
            code: 'FEATURE_VERSION_CHANGED',
            currentVersionId: current.version_id,
            changedPaths: await this.changedPaths(
              manager,
              featureId,
              mutation.baseVersionId,
              current,
            ),
          },
        },
      };
    }
    if (mutation.operation === 'delete') {
      if (mutation.patch || mutation.feature) {
        throw new AppException(422, 'SCHEMA_VIOLATION', 'Delete không nhận patch hoặc feature.');
      }
      await manager.query(`DELETE FROM revision_features WHERE revision_id=$1 AND feature_id=$2`, [
        revision.id,
        featureId,
      ]);
      await this.insertChange(
        manager,
        revision.id,
        nextCursor,
        'delete',
        featureId,
        null,
        [],
        actor.id,
      );
      await this.insertFeatureAudit(manager, actor, requestId, 'feature.deleted', featureId, {
        revisionId: revision.id,
        origin,
        clientMutationId: mutation.clientMutationId,
      });
      return {
        applied: true,
        result: {
          clientMutationId: mutation.clientMutationId,
          status: 'applied',
          operation: 'delete',
          clientFeatureId: mutation.clientFeatureId ?? null,
          canonicalFeatureId: featureId,
          versionId: null,
          serverCursor: cursorEncode(nextCursor),
        },
      };
    }
    if (!mutation.patch || mutation.feature) {
      throw new AppException(422, 'SCHEMA_VIOLATION', 'Update cần patch và không nhận feature.');
    }
    const next = await this.mergePatch(manager, fields, current, mutation.patch);
    await this.validateFeature(revision, fields, next, true);
    if (
      next.externalSource !== current.external_source ||
      next.externalId !== current.external_id
    ) {
      await manager.query(`UPDATE features SET external_source=$2,external_id=$3 WHERE id=$1`, [
        featureId,
        next.externalSource ?? null,
        next.externalId ?? null,
      ]);
    }
    const versionId = await this.insertVersion(
      manager,
      revision.id,
      featureId,
      next.geometry,
      next.geometryKind,
      next.properties,
      next.radiusM ?? null,
      actor.id,
    );
    await manager.query(
      `INSERT INTO feature_version_attachments(feature_version_id,attachment_id,field_key,display_order)
       SELECT $1,attachment_id,field_key,display_order
       FROM feature_version_attachments WHERE feature_version_id=$2`,
      [versionId, current.version_id],
    );
    await manager.query(
      `UPDATE revision_features SET feature_version_id=$3
       WHERE revision_id=$1 AND feature_id=$2`,
      [revision.id, featureId, versionId],
    );
    const changedPaths = this.patchChangedPaths(mutation.patch);
    await this.insertChange(
      manager,
      revision.id,
      nextCursor,
      'update',
      featureId,
      versionId,
      changedPaths,
      actor.id,
    );
    await this.insertFeatureAudit(manager, actor, requestId, 'feature.updated', featureId, {
      revisionId: revision.id,
      origin,
      clientMutationId: mutation.clientMutationId,
      previousVersionId: current.version_id,
      versionId,
    });
    return {
      applied: true,
      result: {
        clientMutationId: mutation.clientMutationId,
        status: 'applied',
        operation: 'update',
        clientFeatureId: mutation.clientFeatureId ?? null,
        canonicalFeatureId: featureId,
        versionId,
        serverCursor: cursorEncode(nextCursor),
      },
    };
  }

  private async mergePatch(
    manager: EntityManager,
    fields: LayerFieldDto[],
    current: CurrentFeatureRow,
    patch: FeatureSyncPatchDto,
  ): Promise<FeatureMutationDto> {
    const properties = structuredClone(current.properties);
    for (const [key, value] of Object.entries(patch.properties ?? {})) properties[key] = value;
    for (const key of patch.unsetProperties ?? []) delete properties[key];
    const attachments = (await manager.query(
      `SELECT link.attachment_id AS id,link.field_key,link.display_order
       FROM feature_version_attachments link WHERE link.feature_version_id=$1`,
      [current.version_id],
    )) as FeatureAttachmentRow[];
    for (const field of fields.filter((candidate) =>
      ['image', 'attachment'].includes(candidate.type),
    )) {
      if (
        Object.hasOwn(patch.properties ?? {}, field.key) ||
        patch.unsetProperties?.includes(field.key)
      ) {
        throw new AppException(
          422,
          'SCHEMA_VIOLATION',
          `Field tệp đính kèm ${field.key} chỉ được thay đổi qua attachment API.`,
        );
      }
      properties[field.key] = attachments
        .filter((attachment) => attachment.field_key === field.key)
        .sort(
          (left, right) =>
            left.display_order - right.display_order || left.id.localeCompare(right.id),
        )
        .map((attachment) => attachment.id);
    }
    const externalSource =
      patch.externalSource === undefined ? current.external_source : patch.externalSource;
    const externalId = patch.externalId === undefined ? current.external_id : patch.externalId;
    return {
      geometry: patch.geometry ?? current.geometry,
      geometryKind: patch.geometryKind ?? current.geometry_kind,
      radiusM: patch.radiusM === undefined ? current.radius_m : patch.radiusM,
      externalSource: externalSource ?? undefined,
      externalId: externalId ?? undefined,
      properties,
    };
  }

  private async validateFeature(
    revision: LockedRevision,
    fields: LayerFieldDto[],
    feature: FeatureMutationDto,
    allowMaterializedAttachments: boolean,
  ): Promise<void> {
    this.assertExternalIdentity(feature.externalSource, feature.externalId);
    if (!revision.allowed_geometry_kinds.includes(feature.geometryKind)) {
      throw new AppException(
        422,
        'GEOMETRY_TYPE_NOT_ALLOWED',
        'Loại geometry không được cho phép trong layer này.',
      );
    }
    await this.geometry.validate(feature.geometry, feature.geometryKind, feature.radiusM);
    this.schema.validateProperties(fields, feature.properties, { allowMaterializedAttachments });
  }

  private async insertVersion(
    manager: EntityManager,
    revisionId: string,
    featureId: string,
    geometry: Record<string, unknown>,
    geometryKind: GeometryKind,
    properties: Record<string, unknown>,
    radiusM: number | null,
    actorId: string,
  ): Promise<string> {
    const rows = (await manager.query(
      `INSERT INTO feature_versions(
         feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by
       ) VALUES($1,$2,ST_SetSRID(ST_GeomFromGeoJSON($3),4326),$4,$5::jsonb,$6,$7,$8)
       RETURNING id`,
      [
        featureId,
        revisionId,
        JSON.stringify(geometry),
        geometryKind,
        JSON.stringify(properties),
        radiusM,
        this.featureChecksum(geometry, properties, radiusM),
        actorId,
      ],
    )) as Array<{ id: string }>;
    return rows[0]!.id;
  }

  private async currentFeature(
    manager: EntityManager,
    revisionId: string,
    featureId: string,
  ): Promise<CurrentFeatureRow | undefined> {
    const rows = (await manager.query(
      `SELECT feature.id,ST_AsGeoJSON(version.geometry)::jsonb AS geometry,version.properties,
              version.geometry_kind,version.radius_m,feature.external_source,feature.external_id,
              version.id AS version_id
       FROM revision_features link
       JOIN features feature ON feature.id=link.feature_id
       JOIN feature_versions version ON version.id=link.feature_version_id
       WHERE link.revision_id=$1 AND link.feature_id=$2
       FOR UPDATE OF link,feature`,
      [revisionId, featureId],
    )) as CurrentFeatureRow[];
    return rows[0];
  }

  private async changedPaths(
    manager: EntityManager,
    featureId: string,
    baseVersionId: string,
    current: CurrentFeatureRow,
  ): Promise<string[]> {
    const rows = (await manager.query(
      `SELECT ST_AsGeoJSON(geometry)::jsonb AS geometry,properties,geometry_kind,radius_m
       FROM feature_versions WHERE id=$1 AND feature_id=$2`,
      [baseVersionId, featureId],
    )) as Array<{
      geometry: Record<string, unknown>;
      properties: Record<string, unknown>;
      geometry_kind: GeometryKind;
      radius_m: number | null;
    }>;
    const base = rows[0];
    if (!base) return ['geometry', 'properties'];
    const paths: string[] = [];
    if (
      JSON.stringify(base.geometry) !== JSON.stringify(current.geometry) ||
      base.geometry_kind !== current.geometry_kind ||
      base.radius_m !== current.radius_m
    ) {
      paths.push('geometry');
    }
    const keys = new Set([...Object.keys(base.properties), ...Object.keys(current.properties)]);
    for (const key of [...keys].sort()) {
      if (JSON.stringify(base.properties[key]) !== JSON.stringify(current.properties[key])) {
        paths.push(`properties.${key}`);
      }
    }
    return paths.length ? paths : ['version'];
  }

  private patchChangedPaths(patch: FeatureSyncPatchDto): string[] {
    const paths = new Set<string>();
    if (
      patch.geometry !== undefined ||
      patch.geometryKind !== undefined ||
      patch.radiusM !== undefined
    ) {
      paths.add('geometry');
    }
    if (patch.externalSource !== undefined || patch.externalId !== undefined) {
      paths.add('externalIdentity');
    }
    for (const key of Object.keys(patch.properties ?? {})) paths.add(`properties.${key}`);
    for (const key of patch.unsetProperties ?? []) paths.add(`properties.${key}`);
    return [...paths].sort();
  }

  private async lockRevision(manager: EntityManager, revisionId: string): Promise<LockedRevision> {
    const rows = (await manager.query(
      `SELECT id,layer_id,status,allowed_geometry_kinds,lock_version,cursor_seq,change_cursor_floor
       FROM layer_revisions WHERE id=$1 FOR UPDATE`,
      [revisionId],
    )) as LockedRevision[];
    if (!rows[0]) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    return rows[0];
  }

  private async loadReceipts(
    manager: EntityManager,
    revisionId: string,
    clientId: string,
    mutationIds: string[],
  ): Promise<Map<string, MutationReceiptRow>> {
    const rows = (await manager.query(
      `SELECT mutation_id,request_digest,response_payload,server_cursor,
              client_feature_id,canonical_feature_id
       FROM client_mutations
       WHERE revision_id=$1 AND client_id=$2 AND mutation_id=ANY($3::uuid[])`,
      [revisionId, clientId, mutationIds],
    )) as MutationReceiptRow[];
    return new Map(rows.map((row) => [row.mutation_id, row]));
  }

  private async loadClientMappings(
    manager: EntityManager,
    revisionId: string,
    clientId: string,
  ): Promise<Map<string, string>> {
    const rows = (await manager.query(
      `SELECT client_feature_id,canonical_feature_id FROM client_mutations
       WHERE revision_id=$1 AND client_id=$2
         AND client_feature_id IS NOT NULL AND canonical_feature_id IS NOT NULL`,
      [revisionId, clientId],
    )) as Array<{ client_feature_id: string; canonical_feature_id: string }>;
    return new Map(rows.map((row) => [row.client_feature_id, row.canonical_feature_id]));
  }

  private async persistReceipt(
    manager: EntityManager,
    revisionId: string,
    clientId: string,
    mutation: FeatureSyncMutationDto,
    payloadHash: string,
    result: FeatureSyncResult,
    cursor: number,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO client_mutations(
         revision_id,client_id,mutation_id,request_digest,response_payload,server_cursor,
         client_feature_id,canonical_feature_id
       ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
      [
        revisionId,
        clientId,
        mutation.clientMutationId,
        payloadHash,
        JSON.stringify(result),
        cursor,
        mutation.clientFeatureId ?? null,
        result.status === 'applied' ? result.canonicalFeatureId : null,
      ],
    );
  }

  private async insertChange(
    manager: EntityManager,
    revisionId: string,
    serverCursor: number,
    operation: 'create' | 'update' | 'delete',
    featureId: string,
    versionId: string | null,
    changedPaths: string[],
    actorId: string,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO revision_changes(
         revision_id,server_cursor,operation,feature_id,version_id,changed_paths,actor_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [revisionId, serverCursor, operation, featureId, versionId, changedPaths, actorId],
    );
  }

  private rejectedResult(
    mutation: FeatureSyncMutationDto,
    error: unknown,
    cursor: number,
  ): FeatureSyncResult {
    if (error instanceof QueryFailedError) {
      const driver = error.driverError as { code?: string; constraint?: string };
      if (driver.code === '23505' && driver.constraint === 'uq_features_external_identity') {
        return this.errorResult(
          mutation,
          cursor,
          'EXTERNAL_IDENTITY_CONFLICT',
          'External identity đã tồn tại trong layer.',
        );
      }
    }
    if (error instanceof AppException) {
      const body = error.getResponse() as {
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
      };
      return this.errorResult(
        mutation,
        cursor,
        body.code ?? error.code,
        body.message ?? 'Mutation không thể áp dụng.',
        body.details ?? error.details,
      );
    }
    throw error;
  }

  private errorResult(
    mutation: FeatureSyncMutationDto,
    cursor: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ): FeatureSyncResult {
    return {
      clientMutationId: mutation.clientMutationId,
      status: 'rejected',
      operation: mutation.operation,
      canonicalFeatureId: mutation.featureId ?? null,
      serverCursor: cursorEncode(cursor),
      error: { code, message, details },
    };
  }

  private mutationPayloadHash(mutation: FeatureSyncMutationDto): string {
    const payload = structuredClone(mutation) as unknown as Record<string, unknown>;
    delete payload.payloadHash;
    return this.crypto.checksum(JSON.stringify(this.canonical(payload)));
  }

  private featureChecksum(
    geometry: Record<string, unknown>,
    properties: Record<string, unknown>,
    radiusM: number | null,
  ): string {
    return this.crypto.checksum(
      JSON.stringify(
        this.canonical({ geometry, properties, radiusM: radiusM ?? null, attachments: [] }),
      ),
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

  private assertExternalIdentity(source?: string, id?: string): void {
    if (Boolean(source) !== Boolean(id)) {
      throw new AppException(
        422,
        'SCHEMA_VIOLATION',
        'externalSource và externalId phải được cung cấp cùng nhau.',
      );
    }
  }

  private async insertFeatureAudit(
    manager: EntityManager,
    actor: Actor,
    requestId: string,
    action: string,
    featureId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
       VALUES($1,$2,$3,'feature',$4,$5,$6::jsonb)`,
      [actor.id, actor.role, action, featureId, requestId, JSON.stringify(metadata)],
    );
  }

  private async insertAudit(
    manager: EntityManager,
    actor: Actor,
    requestId: string,
    action: string,
    revisionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
       VALUES($1,$2,$3,'layer_revision',$4,$5,$6::jsonb)`,
      [actor.id, actor.role, action, revisionId, requestId, JSON.stringify(metadata)],
    );
  }
}
