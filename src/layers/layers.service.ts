import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, QueryFailedError, Repository } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { GeometryKind } from '../domain/enums';
import type {
  CreateLayerDto,
  CreateLayerGroupDto,
  FeatureMutationDto,
  LayerFieldDto,
  LayerRenderConfigDto,
  LayerStyleDto,
  UpdateFeatureDto,
} from './layer.dto';
import {
  LayerEntity,
  LayerFieldEntity,
  LayerGroupEntity,
  LayerRevisionEntity,
  RevisionChangeEntity,
  RevisionFeatureEntity,
} from './layer.entities';
import { RevisionParticipantEntity } from '../workflow/workflow.entities';
import { GeometryService } from './geometry.service';
import { LayerSchemaService } from './layer-schema.service';
import { requireRevisionVersion, revisionEtag } from './etag';

interface Actor {
  id: string;
  role: string;
}

interface FeatureRow {
  id: string;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
  geometry_kind: GeometryKind;
  radius_m: number | null;
  external_source: string | null;
  external_id: string | null;
  version_id: string;
  updated_at: Date;
}

@Injectable()
export class LayersService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(LayerGroupEntity) private readonly groups: Repository<LayerGroupEntity>,
    @InjectRepository(LayerEntity) private readonly layers: Repository<LayerEntity>,
    @InjectRepository(LayerRevisionEntity)
    private readonly revisions: Repository<LayerRevisionEntity>,
    @InjectRepository(LayerFieldEntity) private readonly fields: Repository<LayerFieldEntity>,
    private readonly geometry: GeometryService,
    private readonly schema: LayerSchemaService,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async listGroups() {
    return this.groups.find({
      where: { archivedAt: IsNull() },
      order: { displayOrder: 'ASC', title: 'ASC' },
    });
  }

  async createGroup(
    dto: CreateLayerGroupDto,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    const requestDigest = this.idempotency.digest({ dto });
    try {
      return await this.dataSource.transaction(async (manager) => {
        const receipt = await this.idempotency.claim<LayerGroupEntity>(
          manager,
          actor.id,
          'layer_group.create',
          idempotencyKey,
          requestDigest,
        );
        if (!receipt.owner) {
          if (receipt.response) return receipt.response;
          throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
        }
        const group = await manager.save(LayerGroupEntity, {
          slug: dto.slug,
          title: dto.title,
          description: dto.description ?? null,
          displayOrder: dto.displayOrder,
          defaultVisible: dto.defaultVisible,
          archivedAt: null,
        });
        await this.insertAudit(
          manager,
          actor,
          requestId,
          'layer_group.created',
          'layer_group',
          group.id,
          {},
        );
        await this.idempotency.complete(
          manager,
          actor.id,
          'layer_group.create',
          idempotencyKey,
          group,
          201,
        );
        return group;
      });
    } catch (error) {
      this.rethrowSlugConflict(error, 'uq_layer_groups_slug_active', 'Nhóm layer');
    }
  }

  async listLayers() {
    const rows: unknown = await this.dataSource.query(`
      SELECT l.id, l.slug, l.group_id AS "groupId", l.display_order AS "displayOrder",
             l.default_visible AS "defaultVisible",
             l.archived_at AS "archivedAt", r.id AS "revisionId", r.title,
             r.status, r.geometry_mode AS "geometryMode", r.updated_at AS "updatedAt"
      FROM layers l
      LEFT JOIN LATERAL (
        SELECT * FROM layer_revisions lr WHERE lr.layer_id = l.id ORDER BY lr.revision_no DESC LIMIT 1
      ) r ON true
      WHERE l.archived_at IS NULL
      ORDER BY l.display_order, l.slug
    `);
    return rows as unknown[];
  }

  async createLayer(dto: CreateLayerDto, actor: Actor, requestId: string, idempotencyKey: string) {
    this.schema.validateLayer(
      dto.geometryMode,
      dto.allowedGeometryKinds,
      dto.fields,
      dto.popupConfig,
      dto.style,
      dto.renderConfig,
    );
    const requestDigest = this.idempotency.digest({ dto });
    try {
      return await this.dataSource.transaction(async (manager) => {
        const receipt = await this.idempotency.claim<{
          layer: LayerEntity;
          draftRevision: LayerRevisionEntity;
          etag: string;
        }>(manager, actor.id, 'layer.create', idempotencyKey, requestDigest);
        if (!receipt.owner) {
          if (receipt.response) return receipt.response;
          throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
        }
        if (dto.groupId) {
          const group = await manager.findOne(LayerGroupEntity, {
            where: { id: dto.groupId, archivedAt: IsNull() },
            lock: { mode: 'pessimistic_read' },
          });
          if (!group) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy nhóm layer.');
        }
        const layer = await manager.save(LayerEntity, {
          slug: dto.slug,
          groupId: dto.groupId ?? null,
          displayOrder: dto.displayOrder,
          defaultVisible: dto.defaultVisible,
          createdBy: actor.id,
          archivedAt: null,
        });
        const revision = await manager.save(LayerRevisionEntity, {
          layerId: layer.id,
          revisionNo: 1,
          status: 'draft',
          title: dto.title,
          description: dto.description ?? null,
          geometryMode: dto.geometryMode,
          allowedGeometryKinds: dto.allowedGeometryKinds,
          style: this.sanitizeStyle(dto.style),
          renderConfig: this.sanitizeRenderConfig(dto.renderConfig),
          popupConfig: structuredClone(dto.popupConfig) as Record<string, unknown>,
          schemaVersion: 1,
          lockVersion: 1,
          cursorSeq: '0',
          createdBy: actor.id,
          supersedesRevisionId: null,
          submittedAt: null,
          approvedAt: null,
          publishedAt: null,
        });
        await manager.save(
          LayerFieldEntity,
          dto.fields.map((field) =>
            manager.create(LayerFieldEntity, {
              revisionId: revision.id,
              key: field.key,
              label: field.label,
              description: field.description ?? null,
              type: field.type,
              icon: field.icon ?? null,
              required: field.required,
              public: field.public,
              searchable: field.searchable,
              filterable: field.filterable,
              sortable: field.sortable,
              sensitive: field.sensitive,
              offlineCache: field.sensitive ? false : field.offlineCache,
              defaultValue: field.defaultValue,
              validation: structuredClone(field.validation) as Record<string, unknown>,
              options: field.options,
              displayOrder: field.displayOrder,
            }),
          ),
        );
        await manager.insert(RevisionParticipantEntity, {
          revisionId: revision.id,
          userId: actor.id,
          participationType: 'edit',
        });
        await this.insertAudit(manager, actor, requestId, 'layer.created', 'layer', layer.id, {
          revisionId: revision.id,
        });
        const response = { layer, draftRevision: revision, etag: revisionEtag(revision.id, 1) };
        await this.idempotency.complete(
          manager,
          actor.id,
          'layer.create',
          idempotencyKey,
          response,
          201,
          response.etag,
        );
        return response;
      });
    } catch (error) {
      this.rethrowSlugConflict(error, 'uq_layers_slug_active', 'Layer');
    }
  }

  async getRevision(revisionId: string) {
    const revision = await this.revisions.findOneBy({ id: revisionId });
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    const fields = await this.fields.find({
      where: { revisionId },
      order: { displayOrder: 'ASC', key: 'ASC' },
    });
    return { revision, fields, etag: revisionEtag(revision.id, revision.lockVersion) };
  }

  async workspace(revisionId: string) {
    const revision = await this.revisions.findOneBy({ id: revisionId });
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    const rows = (await this.dataSource.query(
      `
        SELECT count(rf.feature_id)::integer AS feature_count,
          CASE WHEN count(rf.feature_id) = 0 THEN NULL ELSE ARRAY[
            ST_XMin(ST_Extent(fv.geometry)), ST_YMin(ST_Extent(fv.geometry)),
            ST_XMax(ST_Extent(fv.geometry)), ST_YMax(ST_Extent(fv.geometry))
          ] END AS bounds
        FROM revision_features rf
        JOIN feature_versions fv ON fv.id = rf.feature_version_id
        WHERE rf.revision_id = $1
      `,
      [revisionId],
    )) as Array<{ feature_count: number; bounds: number[] | null }>;
    const summary = rows[0] ?? { feature_count: 0, bounds: null };
    return {
      data: {
        revisionId,
        layerId: revision.layerId,
        status: revision.status,
        serverCursor: Buffer.from(revision.cursorSeq, 'utf8').toString('base64url'),
        featureCount: summary.feature_count,
        bounds: summary.bounds,
        schemaVersion: revision.schemaVersion,
        updatedAt: revision.updatedAt.toISOString(),
      },
      etag: revisionEtag(revision.id, revision.lockVersion),
    };
  }

  async listFeatures(revisionId: string, bboxValue: string | undefined, limitValue: number) {
    await this.assertRevisionExists(revisionId);
    const bbox = bboxValue ? this.parseBbox(bboxValue) : null;
    const limit = Math.min(Math.max(limitValue || 200, 1), 500);
    const rows = (await this.dataSource.query(
      `
        SELECT f.id, ST_AsGeoJSON(fv.geometry)::jsonb AS geometry, fv.properties,
               fv.geometry_kind, fv.radius_m, f.external_source, f.external_id,
               fv.id AS version_id, fv.created_at AS updated_at
        FROM revision_features rf
        JOIN features f ON f.id = rf.feature_id
        JOIN feature_versions fv ON fv.id = rf.feature_version_id
        WHERE rf.revision_id = $1
          AND ($2::double precision[] IS NULL OR fv.geometry && ST_MakeEnvelope($2[1],$2[2],$2[3],$2[4],4326))
        ORDER BY rf.ordinal, f.id
        LIMIT $3
      `,
      [revisionId, bbox, limit],
    )) as FeatureRow[];
    return rows.map((row) => this.featureDto(row));
  }

  async createFeature(
    revisionId: string,
    dto: FeatureMutationDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    const expectedVersion = requireRevisionVersion(ifMatch, revisionId);
    const requestDigest = this.idempotency.digest({ revisionId, dto, ifMatch });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{
        feature: Record<string, unknown>;
        serverCursor: string;
        etag: string;
      }>(manager, actor.id, 'feature.create', idempotencyKey, requestDigest);
      if (!receipt.owner) {
        if (receipt.response) return receipt.response;
        throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
      }
      const revision = await manager.findOneBy(LayerRevisionEntity, { id: revisionId });
      if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
      if (revision.status !== 'draft') {
        throw new AppException(409, 'REVISION_NOT_EDITABLE', 'Revision không ở trạng thái draft.');
      }
      const fields = await manager.findBy(LayerFieldEntity, { revisionId });
      this.assertGeometryAllowed(revision.allowedGeometryKinds, dto.geometryKind);
      await this.geometry.validate(dto.geometry, dto.geometryKind, dto.radiusM);
      this.schema.validateProperties(fields as unknown as LayerFieldDto[], dto.properties);
      this.assertExternalIdentity(dto.externalSource, dto.externalId);
      const locked = await this.lockRevision(manager, revisionId, expectedVersion);
      const featureRows = (await manager.query(
        `INSERT INTO features(layer_id, external_source, external_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [revision.layerId, dto.externalSource ?? null, dto.externalId ?? null],
      )) as Array<{ id: string }>;
      const featureId = featureRows[0]!.id;
      const checksum = this.featureChecksum(dto.geometry, dto.properties, dto.radiusM);
      const versionRows = (await manager.query(
        `
          INSERT INTO feature_versions(
            feature_id, revision_id, geometry, geometry_kind, properties, radius_m, checksum, created_by
          ) VALUES (
            $1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3),4326), $4, $5::jsonb, $6, $7, $8
          ) RETURNING id, created_at
        `,
        [
          featureId,
          revisionId,
          JSON.stringify(dto.geometry),
          dto.geometryKind,
          JSON.stringify(dto.properties),
          dto.radiusM ?? null,
          checksum,
          actor.id,
        ],
      )) as Array<{ id: string; created_at: Date }>;
      const version = versionRows[0]!;
      await manager.insert(RevisionFeatureEntity, {
        revisionId,
        featureId,
        featureVersionId: version.id,
        ordinal: 0,
      });
      await manager.insert(RevisionChangeEntity, {
        revisionId,
        serverCursor: String(locked.cursorSeq),
        operation: 'create',
        featureId,
        versionId: version.id,
        changedPaths: ['geometry', 'properties'],
        actorId: actor.id,
      });
      await manager
        .createQueryBuilder()
        .insert()
        .into(RevisionParticipantEntity)
        .values({ revisionId, userId: actor.id, participationType: 'edit' })
        .orIgnore()
        .execute();
      await this.insertAudit(manager, actor, requestId, 'feature.created', 'feature', featureId, {
        revisionId,
      });
      const response = {
        feature: {
          type: 'Feature',
          id: featureId,
          geometry: dto.geometry,
          properties: dto.properties,
          attachments: [],
          meta: {
            geometryKind: dto.geometryKind,
            radiusM: dto.radiusM ?? null,
            externalSource: dto.externalSource ?? null,
            externalId: dto.externalId ?? null,
            versionId: version.id,
            updatedAt: version.created_at.toISOString(),
          },
        },
        serverCursor: Buffer.from(String(locked.cursorSeq)).toString('base64url'),
        etag: revisionEtag(revisionId, locked.lockVersion),
      };
      await this.idempotency.complete(
        manager,
        actor.id,
        'feature.create',
        idempotencyKey,
        response,
        201,
        response.etag,
      );
      return response;
    });
  }

  async updateFeature(
    revisionId: string,
    featureId: string,
    dto: UpdateFeatureDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
  ) {
    const expectedVersion = requireRevisionVersion(ifMatch, revisionId);
    const context = await this.getEditableContext(revisionId);
    const currentRows = (await this.dataSource.query(
      `
        SELECT f.id, ST_AsGeoJSON(fv.geometry)::jsonb AS geometry, fv.properties,
               fv.geometry_kind, fv.radius_m, f.external_source, f.external_id,
               fv.id AS version_id, fv.created_at AS updated_at
        FROM revision_features rf
        JOIN features f ON f.id = rf.feature_id
        JOIN feature_versions fv ON fv.id = rf.feature_version_id
        WHERE rf.revision_id=$1 AND rf.feature_id=$2
      `,
      [revisionId, featureId],
    )) as FeatureRow[];
    const current = currentRows[0];
    if (!current) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy feature.');
    const geometry = dto.geometry ?? current.geometry;
    const kind = dto.geometryKind ?? current.geometry_kind;
    const radiusM = dto.radiusM !== undefined ? dto.radiusM : current.radius_m;
    const properties = dto.properties ?? current.properties;
    this.assertGeometryAllowed(context.revision.allowedGeometryKinds, kind);
    await this.geometry.validate(geometry, kind, radiusM);
    this.schema.validateProperties(context.fields as unknown as LayerFieldDto[], properties);
    return this.dataSource.transaction(async (manager) => {
      const locked = await this.lockRevision(manager, revisionId, expectedVersion);
      const versionRows = (await manager.query(
        `
          INSERT INTO feature_versions(feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by)
          VALUES($1,$2,ST_SetSRID(ST_GeomFromGeoJSON($3),4326),$4,$5::jsonb,$6,$7,$8)
          RETURNING id,created_at
        `,
        [
          featureId,
          revisionId,
          JSON.stringify(geometry),
          kind,
          JSON.stringify(properties),
          radiusM ?? null,
          this.featureChecksum(geometry, properties, radiusM),
          actor.id,
        ],
      )) as Array<{ id: string; created_at: Date }>;
      const version = versionRows[0]!;
      await manager.update(
        RevisionFeatureEntity,
        { revisionId, featureId },
        { featureVersionId: version.id },
      );
      await manager.insert(RevisionChangeEntity, {
        revisionId,
        serverCursor: String(locked.cursorSeq),
        operation: 'update',
        featureId,
        versionId: version.id,
        changedPaths: Object.keys(dto),
        actorId: actor.id,
      });
      await this.insertAudit(manager, actor, requestId, 'feature.updated', 'feature', featureId, {
        revisionId,
        previousVersionId: current.version_id,
        versionId: version.id,
      });
      return {
        feature: this.featureDto({
          ...current,
          geometry,
          geometry_kind: kind,
          radius_m: radiusM ?? null,
          properties,
          version_id: version.id,
          updated_at: version.created_at,
        }),
        serverCursor: Buffer.from(String(locked.cursorSeq)).toString('base64url'),
        etag: revisionEtag(revisionId, locked.lockVersion),
      };
    });
  }

  async deleteFeature(
    revisionId: string,
    featureId: string,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
  ) {
    const expectedVersion = requireRevisionVersion(ifMatch, revisionId);
    await this.getEditableContext(revisionId);
    return this.dataSource.transaction(async (manager) => {
      const locked = await this.lockRevision(manager, revisionId, expectedVersion);
      const result = await manager.delete(RevisionFeatureEntity, { revisionId, featureId });
      if (!result.affected) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy feature.');
      await manager.insert(RevisionChangeEntity, {
        revisionId,
        serverCursor: String(locked.cursorSeq),
        operation: 'delete',
        featureId,
        versionId: null,
        changedPaths: [],
        actorId: actor.id,
      });
      await this.insertAudit(manager, actor, requestId, 'feature.deleted', 'feature', featureId, {
        revisionId,
      });
      return {
        status: 'deleted',
        serverCursor: Buffer.from(String(locked.cursorSeq)).toString('base64url'),
        etag: revisionEtag(revisionId, locked.lockVersion),
      };
    });
  }

  private async getEditableContext(revisionId: string) {
    const revision = await this.revisions.findOneBy({ id: revisionId });
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    if (revision.status !== 'draft') {
      throw new AppException(409, 'REVISION_NOT_EDITABLE', 'Revision không ở trạng thái draft.');
    }
    const fields = await this.fields.find({ where: { revisionId } });
    return { revision, fields };
  }

  private async assertRevisionExists(revisionId: string) {
    if (!(await this.revisions.exist({ where: { id: revisionId } }))) {
      throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    }
  }

  private async lockRevision(
    manager: DataSource['manager'],
    revisionId: string,
    expectedVersion: number,
  ) {
    const rows = (await manager.query(
      `SELECT id,status,lock_version,cursor_seq FROM layer_revisions WHERE id=$1 FOR UPDATE`,
      [revisionId],
    )) as Array<{ id: string; status: string; lock_version: number; cursor_seq: string }>;
    const revision = rows[0];
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    if (revision.status !== 'draft') {
      throw new AppException(409, 'REVISION_NOT_EDITABLE', 'Revision không ở trạng thái draft.');
    }
    if (revision.lock_version !== expectedVersion) {
      throw new AppException(412, 'ETAG_MISMATCH', 'Phiên bản dữ liệu đã thay đổi.', {
        currentEtag: revisionEtag(revisionId, revision.lock_version),
      });
    }
    const lockVersion = revision.lock_version + 1;
    const cursorSeq = Number(revision.cursor_seq) + 1;
    await manager.query(
      `UPDATE layer_revisions SET lock_version=$2,cursor_seq=$3,updated_at=now() WHERE id=$1`,
      [revisionId, lockVersion, cursorSeq],
    );
    return { lockVersion, cursorSeq };
  }

  private assertGeometryAllowed(allowed: GeometryKind[], kind: GeometryKind): void {
    if (!allowed.includes(kind)) {
      throw new AppException(
        422,
        'GEOMETRY_TYPE_NOT_ALLOWED',
        'Loại geometry không được cho phép trong layer này.',
      );
    }
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

  private parseBbox(value: string): number[] {
    const values = value.split(',').map(Number);
    if (
      values.length !== 4 ||
      values.some((coordinate) => !Number.isFinite(coordinate)) ||
      values[0]! >= values[2]! ||
      values[1]! >= values[3]! ||
      values[0]! < -180 ||
      values[2]! > 180 ||
      values[1]! < -90 ||
      values[3]! > 90
    ) {
      throw new AppException(400, 'VALIDATION_FAILED', 'Bbox không hợp lệ.');
    }
    return values;
  }

  private featureChecksum(
    geometry: Record<string, unknown>,
    properties: Record<string, unknown>,
    radiusM?: number | null,
  ): string {
    return this.crypto.checksum(
      JSON.stringify({
        geometry,
        properties: this.sortObject(properties),
        radiusM: radiusM ?? null,
      }),
    );
  }

  private sortObject(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  private featureDto(row: FeatureRow) {
    return {
      type: 'Feature',
      id: row.id,
      geometry: row.geometry,
      properties: row.properties,
      attachments: [],
      meta: {
        geometryKind: row.geometry_kind,
        radiusM: row.radius_m,
        externalSource: row.external_source,
        externalId: row.external_id,
        versionId: row.version_id,
        updatedAt: row.updated_at.toISOString(),
      },
    };
  }

  private sanitizeStyle(style: LayerStyleDto): Record<string, unknown> {
    return structuredClone(style) as Record<string, unknown>;
  }

  private sanitizeRenderConfig(config: LayerRenderConfigDto): Record<string, unknown> {
    return structuredClone(config) as Record<string, unknown>;
  }

  private rethrowSlugConflict(error: unknown, constraint: string, resource: string): never {
    if (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string; constraint?: string }).code === '23505' &&
      (error.driverError as { code?: string; constraint?: string }).constraint === constraint
    ) {
      throw new AppException(409, 'SLUG_CONFLICT', `${resource} có slug đang hoạt động bị trùng.`);
    }
    throw error;
  }

  private async insertAudit(
    manager: DataSource['manager'],
    actor: Actor,
    requestId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [actor.id, actor.role, action, resourceType, resourceId, requestId, JSON.stringify(metadata)],
    );
  }
}
