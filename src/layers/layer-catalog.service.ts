import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, QueryFailedError, Repository } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type {
  ArchiveLayerGroupDto,
  ReorderCatalogDto,
  UpdateLayerDto,
  UpdateLayerGroupDto,
} from './layer.dto';
import { LayerEntity, LayerGroupEntity, LayerRevisionEntity } from './layer.entities';
import { requireResourceVersion, resourceEtag } from './etag';

interface Actor {
  id: string;
  role: string;
}

export interface VersionedItem {
  id: string;
  lockVersion: number;
  displayOrder?: number;
  archivedAt?: Date | string | null;
  revisionId?: string | null;
  revisionLockVersion?: number | null;
  status?: string | null;
}

@Injectable()
export class LayerCatalogService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(LayerGroupEntity) private readonly groups: Repository<LayerGroupEntity>,
    @InjectRepository(LayerEntity) private readonly layers: Repository<LayerEntity>,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listGroups(includeArchived: boolean) {
    const data = await this.groups.find({
      where: includeArchived ? {} : { archivedAt: IsNull() },
      order: { displayOrder: 'ASC', title: 'ASC', id: 'ASC' },
    });
    return { data, etag: this.collectionEtag('layer-groups', data) };
  }

  async getGroup(groupId: string) {
    const group = await this.groups.findOneBy({ id: groupId });
    if (!group) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy nhóm layer.');
    return { group, etag: resourceEtag('layer-group', group.id, group.lockVersion) };
  }

  async updateGroup(
    groupId: string,
    dto: UpdateLayerGroupDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    this.assertNonEmptyMutation(dto);
    const expectedVersion = requireResourceVersion(ifMatch, 'layer-group', groupId);
    const requestDigest = this.idempotency.digest({ groupId, dto, expectedVersion });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{
        group: LayerGroupEntity;
        etag: string;
      }>(manager, actor.id, 'layer_group.update', idempotencyKey, requestDigest);
      if (!receipt.owner) return this.replayed(receipt.response);
      const group = await manager.findOne(LayerGroupEntity, {
        where: { id: groupId },
        lock: { mode: 'pessimistic_write' },
      });
      this.assertGroupVersion(group, expectedVersion);
      if (group!.archivedAt) {
        throw new AppException(409, 'GROUP_ARCHIVED', 'Nhóm layer đã được lưu trữ.');
      }
      const before = this.groupAuditShape(group!);
      if (dto.title !== undefined) group!.title = dto.title;
      if (dto.description !== undefined) group!.description = dto.description;
      if (dto.displayOrder !== undefined) group!.displayOrder = dto.displayOrder;
      if (dto.defaultVisible !== undefined) group!.defaultVisible = dto.defaultVisible;
      group!.lockVersion += 1;
      const saved = await manager.save(group!);
      const etag = resourceEtag('layer-group', saved.id, saved.lockVersion);
      await this.audit(manager, actor, requestId, 'layer_group.updated', 'layer_group', saved.id, {
        before,
        after: this.groupAuditShape(saved),
      });
      const response = { group: saved, etag };
      await this.idempotency.complete(
        manager,
        actor.id,
        'layer_group.update',
        idempotencyKey,
        response,
        200,
        etag,
      );
      return response;
    });
  }

  async reorderGroups(
    dto: ReorderCatalogDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    if (!ifMatch) throw new AppException(428, 'ETAG_REQUIRED', 'Thiếu If-Match.');
    const requestDigest = this.idempotency.digest({ dto, ifMatch });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{
        data: { updatedCount: number; items: Array<Record<string, unknown>> };
        etag: string;
      }>(manager, actor.id, 'layer_group.reorder', idempotencyKey, requestDigest);
      if (!receipt.owner) return this.replayed(receipt.response);
      const groups = await manager.find(LayerGroupEntity, {
        where: { archivedAt: IsNull() },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const currentEtag = this.collectionEtag('layer-groups', groups);
      this.assertCollectionVersion(ifMatch, currentEtag);
      this.assertKnownIds(
        dto.items.map((item) => item.id),
        groups,
        'nhóm layer',
      );
      const rows = (await manager.query(
        `UPDATE layer_groups target
         SET display_order=source.display_order,lock_version=target.lock_version+1,updated_at=now()
         FROM (SELECT * FROM unnest($1::uuid[],$2::integer[]) AS value(id,display_order)) source
         WHERE target.id=source.id
         RETURNING target.id,target.display_order AS "displayOrder",target.lock_version AS "lockVersion"`,
        [dto.items.map((item) => item.id), dto.items.map((item) => item.displayOrder)],
      )) as Array<{ id: string; displayOrder: number; lockVersion: number }>;
      const refreshed = await manager.find(LayerGroupEntity, {
        where: { archivedAt: IsNull() },
        order: { displayOrder: 'ASC', title: 'ASC', id: 'ASC' },
      });
      const etag = this.collectionEtag('layer-groups', refreshed);
      const data = { updatedCount: rows.length, items: rows };
      await this.audit(manager, actor, requestId, 'layer_group.reordered', 'layer_group', null, {
        before: this.catalogOrderAuditShape(groups),
        after: this.catalogOrderAuditShape(refreshed),
      });
      const response = { data, etag };
      await this.idempotency.complete(
        manager,
        actor.id,
        'layer_group.reorder',
        idempotencyKey,
        response,
        200,
        etag,
      );
      return response;
    });
  }

  async archiveGroup(
    groupId: string,
    dto: ArchiveLayerGroupDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    const expectedVersion = requireResourceVersion(ifMatch, 'layer-group', groupId);
    const requestDigest = this.idempotency.digest({ groupId, dto, expectedVersion });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{
        group: LayerGroupEntity;
        etag: string;
      }>(manager, actor.id, 'layer_group.archive', idempotencyKey, requestDigest);
      if (!receipt.owner) return this.replayed(receipt.response);
      const group = await manager.findOne(LayerGroupEntity, {
        where: { id: groupId },
        lock: { mode: 'pessimistic_write' },
      });
      this.assertGroupVersion(group, expectedVersion);
      if (group!.archivedAt) {
        throw new AppException(409, 'GROUP_ALREADY_ARCHIVED', 'Nhóm layer đã được lưu trữ.');
      }
      const before = this.groupAuditShape(group!);
      const ungroupedRows = (await manager.query(
        `WITH ungrouped AS (
           UPDATE layers SET group_id=NULL,lock_version=lock_version+1,updated_at=now()
           WHERE group_id=$1 RETURNING id
         )
         SELECT count(*)::integer AS count,
           encode(digest(COALESCE(string_agg(id::text,'' ORDER BY id),''),'sha256'),'hex') AS digest
         FROM ungrouped`,
        [groupId],
      )) as Array<{ count: number; digest: string }>;
      const ungrouped = ungroupedRows[0] ?? {
        count: 0,
        digest: this.crypto.checksum(''),
      };
      group!.archivedAt = new Date();
      group!.lockVersion += 1;
      const saved = await manager.save(group!);
      const etag = resourceEtag('layer-group', saved.id, saved.lockVersion);
      await this.audit(manager, actor, requestId, 'layer_group.archived', 'layer_group', saved.id, {
        before,
        after: this.groupAuditShape(saved),
        orphanLayerPolicy: dto.orphanLayerPolicy,
        ungroupedLayerCount: Number(ungrouped.count),
        ungroupedLayerIdsDigest: ungrouped.digest,
      });
      const response = { group: saved, etag };
      await this.idempotency.complete(
        manager,
        actor.id,
        'layer_group.archive',
        idempotencyKey,
        response,
        200,
        etag,
      );
      return response;
    });
  }

  async listLayers(includeArchived: boolean) {
    const data = await this.layerList(this.dataSource.manager, includeArchived);
    return { data, etag: this.collectionEtag('layers', data) };
  }

  async getLayer(layerId: string) {
    const data = await this.layerDetail(this.dataSource.manager, layerId);
    return { data, etag: resourceEtag('layer', data.layer.id, data.layer.lockVersion) };
  }

  async updateLayer(
    layerId: string,
    dto: UpdateLayerDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    this.assertNonEmptyMutation(dto);
    const expectedVersion = requireResourceVersion(ifMatch, 'layer', layerId);
    const requestDigest = this.idempotency.digest({ layerId, dto, expectedVersion });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{
        data: Awaited<ReturnType<LayerCatalogService['layerDetail']>>;
        etag: string;
      }>(manager, actor.id, 'layer.update', idempotencyKey, requestDigest);
      if (!receipt.owner) return this.replayed(receipt.response);
      if (dto.groupId) await this.lockActiveGroup(manager, dto.groupId);
      const layer = await manager.findOne(LayerEntity, {
        where: { id: layerId },
        lock: { mode: 'pessimistic_write' },
      });
      this.assertLayerVersion(layer, expectedVersion);
      if (layer!.archivedAt) {
        throw new AppException(409, 'LAYER_ARCHIVED', 'Layer đã được lưu trữ.');
      }
      const before = this.layerAuditShape(layer!);
      if (dto.groupId !== undefined) layer!.groupId = dto.groupId;
      if (dto.displayOrder !== undefined) layer!.displayOrder = dto.displayOrder;
      if (dto.defaultVisible !== undefined) layer!.defaultVisible = dto.defaultVisible;
      layer!.lockVersion += 1;
      const saved = await manager.save(layer!);
      const data = await this.layerDetail(manager, saved.id);
      const etag = resourceEtag('layer', saved.id, saved.lockVersion);
      await this.audit(manager, actor, requestId, 'layer.updated', 'layer', saved.id, {
        before,
        after: this.layerAuditShape(saved),
      });
      const response = { data, etag };
      await this.idempotency.complete(
        manager,
        actor.id,
        'layer.update',
        idempotencyKey,
        response,
        200,
        etag,
      );
      return response;
    });
  }

  async reorderLayers(
    dto: ReorderCatalogDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    if (!ifMatch) throw new AppException(428, 'ETAG_REQUIRED', 'Thiếu If-Match.');
    const requestDigest = this.idempotency.digest({ dto, ifMatch });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{
        data: { updatedCount: number; items: Array<Record<string, unknown>> };
        etag: string;
      }>(manager, actor.id, 'layer.reorder', idempotencyKey, requestDigest);
      if (!receipt.owner) return this.replayed(receipt.response);
      const layers = await manager.find(LayerEntity, {
        where: { archivedAt: IsNull() },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const currentEtag = this.collectionEtag('layers', await this.layerList(manager, false));
      this.assertCollectionVersion(ifMatch, currentEtag);
      this.assertKnownIds(
        dto.items.map((item) => item.id),
        layers,
        'layer',
      );
      const rows = (await manager.query(
        `UPDATE layers target
         SET display_order=source.display_order,lock_version=target.lock_version+1,updated_at=now()
         FROM (SELECT * FROM unnest($1::uuid[],$2::integer[]) AS value(id,display_order)) source
         WHERE target.id=source.id
         RETURNING target.id,target.display_order AS "displayOrder",target.lock_version AS "lockVersion"`,
        [dto.items.map((item) => item.id), dto.items.map((item) => item.displayOrder)],
      )) as Array<{ id: string; displayOrder: number; lockVersion: number }>;
      const refreshed = await this.layerList(manager, false);
      const etag = this.collectionEtag('layers', refreshed);
      const data = { updatedCount: rows.length, items: rows };
      await this.audit(manager, actor, requestId, 'layer.reordered', 'layer', null, {
        before: this.catalogOrderAuditShape(layers),
        after: this.catalogOrderAuditShape(refreshed),
      });
      const response = { data, etag };
      await this.idempotency.complete(
        manager,
        actor.id,
        'layer.reorder',
        idempotencyKey,
        response,
        200,
        etag,
      );
      return response;
    });
  }

  async setLayerArchived(
    layerId: string,
    archived: boolean,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    const expectedVersion = requireResourceVersion(ifMatch, 'layer', layerId);
    const operation = archived ? 'layer.archive' : 'layer.unarchive';
    const requestDigest = this.idempotency.digest({ layerId, archived, expectedVersion });
    try {
      return await this.dataSource.transaction(async (manager) => {
        const receipt = await this.idempotency.claim<{
          data: Awaited<ReturnType<LayerCatalogService['layerDetail']>>;
          etag: string;
        }>(manager, actor.id, operation, idempotencyKey, requestDigest);
        if (!receipt.owner) return this.replayed(receipt.response);
        const candidate = await manager.findOneBy(LayerEntity, { id: layerId });
        if (!candidate) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer.');
        if (!archived && candidate.groupId) {
          await this.lockActiveGroup(manager, candidate.groupId);
        }
        const layer = await manager.findOne(LayerEntity, {
          where: { id: layerId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!archived && layer && layer.groupId !== candidate.groupId) {
          throw new AppException(412, 'ETAG_MISMATCH', 'Nhóm của layer đã thay đổi.', {
            currentEtag: resourceEtag('layer', layer.id, layer.lockVersion),
          });
        }
        this.assertLayerVersion(layer, expectedVersion);
        if (Boolean(layer!.archivedAt) === archived) {
          throw new AppException(
            409,
            archived ? 'LAYER_ALREADY_ARCHIVED' : 'LAYER_NOT_ARCHIVED',
            archived ? 'Layer đã được lưu trữ.' : 'Layer đang hoạt động.',
          );
        }
        const before = this.layerAuditShape(layer!);
        layer!.archivedAt = archived ? new Date() : null;
        layer!.lockVersion += 1;
        const saved = await manager.save(layer!);
        const data = await this.layerDetail(manager, saved.id);
        const etag = resourceEtag('layer', saved.id, saved.lockVersion);
        await this.audit(
          manager,
          actor,
          requestId,
          archived ? 'layer.archived' : 'layer.unarchived',
          'layer',
          saved.id,
          { before, after: this.layerAuditShape(saved) },
        );
        const response = { data, etag };
        await this.idempotency.complete(
          manager,
          actor.id,
          operation,
          idempotencyKey,
          response,
          200,
          etag,
        );
        return response;
      });
    } catch (error) {
      this.rethrowSlugConflict(error);
    }
  }

  private async layerDetail(manager: DataSource['manager'], layerId: string) {
    const layer = await manager.findOneBy(LayerEntity, { id: layerId });
    if (!layer) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer.');
    const latestRevision = await manager.findOne(LayerRevisionEntity, {
      where: { layerId },
      order: { revisionNo: 'DESC' },
    });
    const draftRevision = await manager.findOne(LayerRevisionEntity, {
      where: { layerId, status: 'draft' },
      order: { revisionNo: 'DESC' },
    });
    const publishedRows = (await manager.query(
      `SELECT r.* FROM layer_publications publication
       JOIN publication_snapshots snapshot ON snapshot.id=publication.active_snapshot_id
       JOIN layer_revisions r ON r.id=snapshot.revision_id
       WHERE publication.layer_id=$1`,
      [layerId],
    )) as Array<Record<string, unknown>>;
    const publishedRevision = publishedRows[0] ? this.revisionFromRow(publishedRows[0]) : null;
    return { layer, latestRevision, draftRevision, publishedRevision };
  }

  private revisionFromRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      layerId: row.layer_id,
      revisionNo: row.revision_no,
      status: row.status,
      title: row.title,
      description: row.description,
      geometryMode: row.geometry_mode,
      allowedGeometryKinds: row.allowed_geometry_kinds,
      style: row.style,
      renderConfig: row.render_config,
      popupConfig: row.popup_config,
      schemaVersion: row.schema_version,
      lockVersion: row.lock_version,
      cursorSeq: String(row.cursor_seq),
      createdBy: row.created_by,
      supersedesRevisionId: row.supersedes_revision_id,
      submittedAt: row.submitted_at,
      approvedAt: row.approved_at,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async lockActiveGroup(manager: DataSource['manager'], groupId: string): Promise<void> {
    const group = await manager.findOne(LayerGroupEntity, {
      where: { id: groupId, archivedAt: IsNull() },
      lock: { mode: 'pessimistic_read' },
    });
    if (!group)
      throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy nhóm layer đang hoạt động.');
  }

  private assertGroupVersion(group: LayerGroupEntity | null, expectedVersion: number): void {
    if (!group) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy nhóm layer.');
    if (group.lockVersion !== expectedVersion) {
      throw new AppException(412, 'ETAG_MISMATCH', 'Phiên bản nhóm layer đã thay đổi.', {
        currentEtag: resourceEtag('layer-group', group.id, group.lockVersion),
      });
    }
  }

  private assertLayerVersion(layer: LayerEntity | null, expectedVersion: number): void {
    if (!layer) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer.');
    if (layer.lockVersion !== expectedVersion) {
      throw new AppException(412, 'ETAG_MISMATCH', 'Phiên bản layer đã thay đổi.', {
        currentEtag: resourceEtag('layer', layer.id, layer.lockVersion),
      });
    }
  }

  private assertCollectionVersion(ifMatch: string, currentEtag: string): void {
    if (ifMatch !== currentEtag) {
      throw new AppException(412, 'ETAG_MISMATCH', 'Danh mục đã thay đổi.', { currentEtag });
    }
  }

  private assertKnownIds(ids: string[], available: VersionedItem[], resource: string): void {
    const known = new Set(available.map((item) => item.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) {
      throw new AppException(404, 'NOT_FOUND', `Không tìm thấy ${resource} đang hoạt động.`, {
        missingIds: missing,
      });
    }
  }

  private assertNonEmptyMutation(dto: object): void {
    if (!Object.values(dto).some((value) => value !== undefined)) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Không có thay đổi nào được cung cấp.');
    }
  }

  private collectionEtag(resource: string, items: VersionedItem[]): string {
    const state = items
      .map((item) => ({
        id: item.id,
        lockVersion: Number(item.lockVersion),
        archived: Boolean(item.archivedAt),
        revisionId: item.revisionId ?? null,
        revisionLockVersion:
          item.revisionLockVersion === undefined || item.revisionLockVersion === null
            ? null
            : Number(item.revisionLockVersion),
        revisionStatus: item.status ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return `"${resource}-${this.crypto.checksum(JSON.stringify(state))}"`;
  }

  private async layerList(
    manager: DataSource['manager'],
    includeArchived: boolean,
  ): Promise<Array<Record<string, unknown> & VersionedItem>> {
    return (await manager.query(
      `SELECT l.id,l.slug,l.group_id AS "groupId",l.display_order AS "displayOrder",
              l.default_visible AS "defaultVisible",l.lock_version AS "lockVersion",
              l.archived_at AS "archivedAt",r.id AS "revisionId",r.title,
              r.status,r.geometry_mode AS "geometryMode",
              r.lock_version AS "revisionLockVersion",r.updated_at AS "updatedAt"
       FROM layers l
       LEFT JOIN LATERAL (
         SELECT * FROM layer_revisions lr
         WHERE lr.layer_id=l.id ORDER BY lr.revision_no DESC LIMIT 1
       ) r ON true
       WHERE ($1::boolean OR l.archived_at IS NULL)
       ORDER BY l.display_order,l.slug,l.id`,
      [includeArchived],
    )) as Array<Record<string, unknown> & VersionedItem>;
  }

  private groupAuditShape(group: LayerGroupEntity) {
    return {
      title: group.title,
      description: group.description,
      displayOrder: group.displayOrder,
      defaultVisible: group.defaultVisible,
      archivedAt: group.archivedAt,
    };
  }

  private layerAuditShape(layer: LayerEntity) {
    return {
      groupId: layer.groupId,
      displayOrder: layer.displayOrder,
      defaultVisible: layer.defaultVisible,
      archivedAt: layer.archivedAt,
    };
  }

  private catalogOrderAuditShape(items: VersionedItem[]) {
    const canonical = items
      .map((item) => ({
        id: item.id,
        displayOrder: Number(item.displayOrder ?? 0),
        lockVersion: Number(item.lockVersion),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return {
      count: canonical.length,
      orderDigest: this.crypto.checksum(JSON.stringify(canonical)),
    };
  }

  private async audit(
    manager: DataSource['manager'],
    actor: Actor,
    requestId: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const before = 'before' in metadata ? JSON.stringify(metadata.before) : null;
    const after = 'after' in metadata ? JSON.stringify(metadata.after) : null;
    await manager.query(
      `INSERT INTO audit_logs(
         actor_id,actor_role,action,resource_type,resource_id,request_id,
         before_digest,after_digest,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        actor.id,
        actor.role,
        action,
        resourceType,
        resourceId,
        requestId,
        before ? this.crypto.checksum(before) : null,
        after ? this.crypto.checksum(after) : null,
        JSON.stringify(metadata),
      ],
    );
  }

  private replayed<T>(response: T | null): T {
    if (!response) throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
    return response;
  }

  private rethrowSlugConflict(error: unknown): never {
    if (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string; constraint?: string }).code === '23505' &&
      (error.driverError as { constraint?: string }).constraint === 'uq_layers_slug_active'
    ) {
      throw new AppException(409, 'SLUG_CONFLICT', 'Layer có slug đang hoạt động bị trùng.');
    }
    throw error;
  }
}
