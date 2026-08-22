import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { GeometryKind } from '../domain/enums';
import { requireRevisionVersion, revisionEtag } from './etag';
import type { LayerFieldDto, RevisionConfigurationDto } from './layer.dto';
import { LayerFieldEntity, LayerRevisionEntity } from './layer.entities';
import { LayerSchemaService } from './layer-schema.service';

interface Actor {
  id: string;
  role: string;
}

type ImpactReasonCode =
  | 'GEOMETRY_KIND_IN_USE'
  | 'FIELD_REMOVAL_WITH_DATA'
  | 'FIELD_CONSTRAINT_CHANGE_WITH_DATA'
  | 'REQUIRED_FIELD_MISSING';

export interface ImpactReason {
  code: ImpactReasonCode;
  fieldKey: string | null;
  geometryKind: GeometryKind | null;
  affectedFeatures: number;
}

export interface ConfigurationImpact {
  featureCount: number;
  blocking: boolean;
  schemaVersionWillIncrement: boolean;
  reasons: ImpactReason[];
}

@Injectable()
export class RevisionConfigurationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly schema: LayerSchemaService,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async createSuccessorDraft(
    layerId: string,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    if (!ifMatch) throw new AppException(428, 'ETAG_REQUIRED', 'Thiếu If-Match.');
    const requestDigest = this.idempotency.digest({ layerId, ifMatch });
    try {
      return await this.dataSource.transaction(async (manager) => {
        const receipt = await this.idempotency.claim<{
          data: {
            sourceRevisionId: string;
            draftRevision: LayerRevisionEntity;
            draftEtag: string;
            featureCount: number;
          };
          etag: string;
        }>(manager, actor.id, 'revision.successor.create', idempotencyKey, requestDigest);
        if (!receipt.owner) return this.replayed(receipt.response);

        const lockedLayer = (await manager.query(
          `SELECT id FROM layers WHERE id=$1 AND archived_at IS NULL FOR UPDATE`,
          [layerId],
        )) as Array<{ id: string }>;
        if (!lockedLayer.length) {
          throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer đang hoạt động.');
        }

        const sourceRows = (await manager.query(
          `SELECT revision.*
           FROM layers layer
           JOIN layer_publications publication ON publication.layer_id=layer.id
           JOIN publication_snapshots snapshot ON snapshot.id=publication.active_snapshot_id
             AND snapshot.status='published'
           JOIN layer_revisions revision ON revision.id=snapshot.revision_id
           WHERE layer.id=$1 AND layer.archived_at IS NULL
           FOR SHARE OF publication,snapshot,revision`,
          [layerId],
        )) as Array<Record<string, unknown>>;
        const source = sourceRows[0];
        if (!source) {
          throw new AppException(
            409,
            'PUBLISHED_REVISION_REQUIRED',
            'Layer chưa có revision đã công bố để tạo successor draft.',
          );
        }
        const sourceRevisionId = String(source.id);
        const expectedVersion = requireRevisionVersion(ifMatch, sourceRevisionId);
        if (Number(source.lock_version) !== expectedVersion) {
          throw new AppException(412, 'ETAG_MISMATCH', 'Published revision đã thay đổi.', {
            currentEtag: revisionEtag(sourceRevisionId, Number(source.lock_version)),
          });
        }
        const activeEditorialRevision = (await manager.query(
          `SELECT id,status FROM layer_revisions
           WHERE layer_id=$1 AND status=ANY($2::text[]) LIMIT 1 FOR UPDATE`,
          [layerId, ['draft', 'in_review', 'approved', 'publishing']],
        )) as Array<{ id: string; status: string }>;
        if (activeEditorialRevision.length) {
          throw new AppException(
            409,
            'DRAFT_ALREADY_EXISTS',
            'Layer đã có chuỗi biên tập đang hoạt động.',
          );
        }

        const createdRows = (await manager.query(
          `INSERT INTO layer_revisions(
             layer_id,revision_no,status,title,description,geometry_mode,allowed_geometry_kinds,
             style,render_config,popup_config,schema_version,lock_version,cursor_seq,created_by,
             supersedes_revision_id
           )
           SELECT revision.layer_id,
             (SELECT COALESCE(max(candidate.revision_no),0)+1
              FROM layer_revisions candidate WHERE candidate.layer_id=revision.layer_id),
             'draft',revision.title,revision.description,revision.geometry_mode,
             revision.allowed_geometry_kinds,revision.style,revision.render_config,
             revision.popup_config,revision.schema_version,1,0,$2,revision.id
           FROM layer_revisions revision WHERE revision.id=$1
           RETURNING *`,
          [sourceRevisionId, actor.id],
        )) as Array<Record<string, unknown>>;
        const draftId = String(createdRows[0]!.id);
        await manager.query(
          `INSERT INTO layer_fields(
             revision_id,key,label,description,type,icon,required,public,searchable,filterable,
             sortable,sensitive,offline_cache,default_value,validation,options,display_order
           )
           SELECT $2,key,label,description,type,icon,required,public,searchable,filterable,
             sortable,sensitive,offline_cache,default_value,validation,options,display_order
           FROM layer_fields WHERE revision_id=$1`,
          [sourceRevisionId, draftId],
        );
        const featureRows = (await manager.query(
          `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
           SELECT $2,feature_id,feature_version_id,ordinal FROM revision_features WHERE revision_id=$1
           RETURNING feature_id`,
          [sourceRevisionId, draftId],
        )) as Array<{ feature_id: string }>;
        await manager.query(
          `INSERT INTO revision_participants(revision_id,user_id,participation_type)
           VALUES($1,$2,'edit') ON CONFLICT DO NOTHING`,
          [draftId, actor.id],
        );
        const draftRevision = await manager.findOneByOrFail(LayerRevisionEntity, { id: draftId });
        const etag = revisionEtag(draftId, draftRevision.lockVersion);
        const data = {
          sourceRevisionId,
          draftRevision,
          draftEtag: etag,
          featureCount: featureRows.length,
        };
        await this.auditSuccessor(
          manager,
          actor,
          requestId,
          draftId,
          sourceRevisionId,
          featureRows.length,
        );
        const response = { data, etag };
        await this.idempotency.complete(
          manager,
          actor.id,
          'revision.successor.create',
          idempotencyKey,
          response,
          201,
          etag,
        );
        return response;
      });
    } catch (error) {
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
  }

  async preview(
    revisionId: string,
    dto: RevisionConfigurationDto,
    ifMatch: string | undefined,
  ): Promise<{ impact: ConfigurationImpact; etag: string }> {
    this.validate(dto);
    const expectedVersion = requireRevisionVersion(ifMatch, revisionId);
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const revision = await manager.findOne(LayerRevisionEntity, {
        where: { id: revisionId },
        lock: { mode: 'pessimistic_read' },
      });
      this.assertEditableRevision(revision);
      this.assertVersion(revision!, expectedVersion);
      const fields = await this.fieldsForRevision(manager, revisionId);
      const impact = await this.calculateImpact(manager, revision!, fields, dto);
      return { impact, etag: revisionEtag(revisionId, revision!.lockVersion) };
    });
  }

  async replace(
    revisionId: string,
    dto: RevisionConfigurationDto,
    ifMatch: string | undefined,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ) {
    this.validate(dto);
    const expectedVersion = requireRevisionVersion(ifMatch, revisionId);
    const requestDigest = this.idempotency.digest({ revisionId, dto, expectedVersion });
    return this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<{
        data: {
          revision: LayerRevisionEntity;
          fields: LayerFieldEntity[];
          impact: ConfigurationImpact;
        };
        etag: string;
      }>(manager, actor.id, 'revision.config.replace', idempotencyKey, requestDigest);
      if (!receipt.owner) return this.replayed(receipt.response);

      const revision = await manager.findOne(LayerRevisionEntity, {
        where: { id: revisionId },
        lock: { mode: 'pessimistic_write' },
      });
      this.assertEditableRevision(revision);
      this.assertVersion(revision!, expectedVersion);
      const fields = await this.fieldsForRevision(manager, revisionId);
      const impact = await this.calculateImpact(manager, revision!, fields, dto);
      if (impact.blocking) {
        throw new AppException(
          422,
          'CONFIG_IMPACT_BLOCKED',
          'Cấu hình mới không tương thích với dữ liệu hiện tại.',
          { impact },
        );
      }

      const before = this.configurationShape(revision!, fields);
      revision!.title = dto.title;
      revision!.description = dto.description ?? null;
      revision!.geometryMode = dto.geometryMode;
      revision!.allowedGeometryKinds = [...dto.allowedGeometryKinds];
      revision!.style = this.jsonObject(dto.style);
      revision!.renderConfig = this.jsonObject(dto.renderConfig);
      revision!.popupConfig = this.jsonObject(dto.popupConfig);
      if (impact.schemaVersionWillIncrement) revision!.schemaVersion += 1;
      revision!.lockVersion += 1;
      const savedRevision = await manager.save(revision!);

      await manager.delete(LayerFieldEntity, { revisionId });
      const savedFields = await manager.save(
        LayerFieldEntity,
        dto.fields.map((field) => this.fieldEntity(manager, revisionId, field)),
      );
      savedFields.sort(
        (left, right) =>
          left.displayOrder - right.displayOrder || left.key.localeCompare(right.key),
      );
      await manager.query(
        `INSERT INTO revision_participants(revision_id,user_id,participation_type)
         VALUES($1,$2,'edit') ON CONFLICT DO NOTHING`,
        [revisionId, actor.id],
      );

      const after = this.configurationShape(savedRevision, savedFields);
      await this.audit(manager, actor, requestId, revisionId, before, after, impact);
      const etag = revisionEtag(revisionId, savedRevision.lockVersion);
      const response = {
        data: { revision: savedRevision, fields: savedFields, impact },
        etag,
      };
      await this.idempotency.complete(
        manager,
        actor.id,
        'revision.config.replace',
        idempotencyKey,
        response,
        200,
        etag,
      );
      return response;
    });
  }

  private validate(dto: RevisionConfigurationDto): void {
    this.schema.validateLayer(
      dto.geometryMode,
      dto.allowedGeometryKinds,
      dto.fields,
      dto.popupConfig,
      dto.style,
      dto.renderConfig,
    );
  }

  private async calculateImpact(
    manager: EntityManager,
    revision: LayerRevisionEntity,
    oldFields: LayerFieldEntity[],
    dto: RevisionConfigurationDto,
  ): Promise<ConfigurationImpact> {
    const countRows = (await manager.query(
      'SELECT count(*)::integer AS count FROM revision_features WHERE revision_id=$1',
      [revision.id],
    )) as Array<{ count: number }>;
    const featureCount = Number(countRows[0]?.count ?? 0);
    const reasons: ImpactReason[] = [];

    const removedKinds = revision.allowedGeometryKinds.filter(
      (kind) => !dto.allowedGeometryKinds.includes(kind),
    );
    if (removedKinds.length) {
      const geometryRows = (await manager.query(
        `SELECT fv.geometry_kind AS kind,count(*)::integer AS count
         FROM revision_features rf
         JOIN feature_versions fv ON fv.id=rf.feature_version_id
         WHERE rf.revision_id=$1 AND fv.geometry_kind=ANY($2::text[])
         GROUP BY fv.geometry_kind`,
        [revision.id, removedKinds],
      )) as Array<{ kind: GeometryKind; count: number }>;
      for (const row of geometryRows) {
        reasons.push({
          code: 'GEOMETRY_KIND_IN_USE',
          fieldKey: null,
          geometryKind: row.kind,
          affectedFeatures: Number(row.count),
        });
      }
    }

    const oldByKey = new Map(oldFields.map((field) => [field.key, field]));
    const newByKey = new Map(dto.fields.map((field) => [field.key, field]));
    for (const field of oldFields) {
      const replacement = newByKey.get(field.key);
      if (!replacement) {
        const affectedFeatures = await this.countPropertyPresent(manager, revision.id, field.key);
        if (affectedFeatures > 0) {
          reasons.push({
            code: 'FIELD_REMOVAL_WITH_DATA',
            fieldKey: field.key,
            geometryKind: null,
            affectedFeatures,
          });
        }
        continue;
      }
      if (this.dataConstraintSignature(field) !== this.dataConstraintSignature(replacement)) {
        const affectedFeatures = await this.countConstraintViolations(
          manager,
          revision.id,
          replacement,
        );
        if (affectedFeatures > 0) {
          reasons.push({
            code: 'FIELD_CONSTRAINT_CHANGE_WITH_DATA',
            fieldKey: field.key,
            geometryKind: null,
            affectedFeatures,
          });
        }
      }
      if (!field.required && replacement.required) {
        const affectedFeatures = await this.countRequiredMissing(manager, revision.id, field.key);
        if (affectedFeatures > 0) {
          reasons.push({
            code: 'REQUIRED_FIELD_MISSING',
            fieldKey: field.key,
            geometryKind: null,
            affectedFeatures,
          });
        }
      }
    }
    for (const field of dto.fields) {
      if (field.required && !oldByKey.has(field.key)) {
        const affectedFeatures = await this.countRequiredMissing(manager, revision.id, field.key);
        if (affectedFeatures > 0) {
          reasons.push({
            code: 'REQUIRED_FIELD_MISSING',
            fieldKey: field.key,
            geometryKind: null,
            affectedFeatures,
          });
        }
      }
    }

    reasons.sort((left, right) =>
      `${left.code}:${left.fieldKey ?? ''}:${left.geometryKind ?? ''}`.localeCompare(
        `${right.code}:${right.fieldKey ?? ''}:${right.geometryKind ?? ''}`,
      ),
    );
    return {
      featureCount,
      blocking: reasons.length > 0,
      schemaVersionWillIncrement:
        this.schemaSignature(revision, oldFields) !== this.schemaSignature(dto, dto.fields),
      reasons,
    };
  }

  private async countPropertyPresent(
    manager: EntityManager,
    revisionId: string,
    key: string,
  ): Promise<number> {
    const rows = (await manager.query(
      `SELECT count(*)::integer AS count
       FROM revision_features rf
       JOIN feature_versions fv ON fv.id=rf.feature_version_id
       WHERE rf.revision_id=$1 AND fv.properties ? $2`,
      [revisionId, key],
    )) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  private async countConstraintViolations(
    manager: EntityManager,
    revisionId: string,
    field: LayerFieldDto,
  ): Promise<number> {
    const rows = (await manager.query(
      `WITH candidate_values AS (
         SELECT fv.properties->$2 AS value
         FROM revision_features rf
         JOIN feature_versions fv ON fv.id=rf.feature_version_id
         WHERE rf.revision_id=$1 AND fv.properties ? $2
       )
       SELECT count(*) FILTER (
         WHERE value <> 'null'::jsonb AND NOT CASE
           WHEN $3::text=ANY($9::text[]) THEN
             CASE WHEN jsonb_typeof(value)='string' THEN
               ($4::integer IS NULL OR char_length(value #>> '{}') >= $4)
               AND ($5::integer IS NULL OR char_length(value #>> '{}') <= $5)
             ELSE false END
           WHEN $3='number' THEN
             CASE WHEN jsonb_typeof(value)='number' THEN
               ($6::numeric IS NULL OR (value #>> '{}')::numeric >= $6)
               AND ($7::numeric IS NULL OR (value #>> '{}')::numeric <= $7)
             ELSE false END
           WHEN $3='integer' THEN
             CASE WHEN jsonb_typeof(value)='number' THEN
               (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
               AND ($6::numeric IS NULL OR (value #>> '{}')::numeric >= $6)
               AND ($7::numeric IS NULL OR (value #>> '{}')::numeric <= $7)
             ELSE false END
           WHEN $3='boolean' THEN jsonb_typeof(value)='boolean'
           WHEN $3='enum' THEN
             jsonb_typeof(value)='string' AND (value #>> '{}')=ANY($8::text[])
           WHEN $3='multi_enum' THEN
             CASE WHEN jsonb_typeof(value)='array' THEN NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(value) item
               WHERE jsonb_typeof(item)<>'string' OR NOT ((item #>> '{}')=ANY($8::text[]))
             ) ELSE false END
           WHEN $3=ANY(ARRAY['image','attachment']::text[]) THEN jsonb_typeof(value)='array'
           ELSE false
         END
       )::integer AS count
       FROM candidate_values`,
      [
        revisionId,
        field.key,
        field.type,
        field.validation.minLength ?? null,
        field.validation.maxLength ?? null,
        field.validation.minimum ?? null,
        field.validation.maximum ?? null,
        field.options,
        ['text', 'long_text', 'date', 'datetime', 'url', 'email', 'phone', 'address'],
      ],
    )) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  private async countRequiredMissing(
    manager: EntityManager,
    revisionId: string,
    key: string,
  ): Promise<number> {
    const rows = (await manager.query(
      `SELECT count(*)::integer AS count
       FROM revision_features rf
       JOIN feature_versions fv ON fv.id=rf.feature_version_id
       WHERE rf.revision_id=$1
         AND (NOT (fv.properties ? $2) OR fv.properties->$2='null'::jsonb OR fv.properties->>$2='')`,
      [revisionId, key],
    )) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  private fieldsForRevision(
    manager: EntityManager,
    revisionId: string,
  ): Promise<LayerFieldEntity[]> {
    return manager.find(LayerFieldEntity, {
      where: { revisionId },
      order: { displayOrder: 'ASC', key: 'ASC' },
    });
  }

  private fieldEntity(
    manager: EntityManager,
    revisionId: string,
    field: LayerFieldDto,
  ): LayerFieldEntity {
    return manager.create(LayerFieldEntity, {
      revisionId,
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
      defaultValue: field.defaultValue ?? null,
      validation: this.jsonObject(field.validation),
      options: [...field.options],
      displayOrder: field.displayOrder,
    });
  }

  private assertEditableRevision(revision: LayerRevisionEntity | null): void {
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    if (revision.status !== 'draft') {
      throw new AppException(409, 'REVISION_NOT_EDITABLE', 'Chỉ draft revision được chỉnh sửa.');
    }
  }

  private assertVersion(revision: LayerRevisionEntity, expectedVersion: number): void {
    if (revision.lockVersion !== expectedVersion) {
      throw new AppException(412, 'ETAG_MISMATCH', 'Revision đã thay đổi.', {
        currentEtag: revisionEtag(revision.id, revision.lockVersion),
      });
    }
  }

  private schemaSignature(
    revision:
      Pick<LayerRevisionEntity, 'geometryMode' | 'allowedGeometryKinds'> | RevisionConfigurationDto,
    fields: Array<LayerFieldEntity | LayerFieldDto>,
  ): string {
    return this.idempotency.digest({
      geometryMode: revision.geometryMode,
      allowedGeometryKinds: [...revision.allowedGeometryKinds].sort(),
      fields: fields
        .map((field) => ({
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
          offlineCache: field.offlineCache,
          defaultValue: field.defaultValue ?? null,
          validation: field.validation,
          options: field.options,
          displayOrder: field.displayOrder,
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    });
  }

  private dataConstraintSignature(field: LayerFieldEntity | LayerFieldDto): string {
    return this.idempotency.digest({
      type: field.type,
      validation: field.validation,
      options: field.options,
    });
  }

  private configurationShape(revision: LayerRevisionEntity, fields: LayerFieldEntity[]) {
    return {
      title: revision.title,
      description: revision.description,
      geometryMode: revision.geometryMode,
      allowedGeometryKinds: revision.allowedGeometryKinds,
      fields,
      style: revision.style,
      renderConfig: revision.renderConfig,
      popupConfig: revision.popupConfig,
      schemaVersion: revision.schemaVersion,
      lockVersion: revision.lockVersion,
    };
  }

  private async audit(
    manager: EntityManager,
    actor: Actor,
    requestId: string,
    revisionId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    impact: ConfigurationImpact,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO audit_logs(
         actor_id,actor_role,action,resource_type,resource_id,request_id,
         before_digest,after_digest,metadata
       ) VALUES($1,$2,'revision.config_updated','revision',$3,$4,$5,$6,$7::jsonb)`,
      [
        actor.id,
        actor.role,
        revisionId,
        requestId,
        this.crypto.checksum(JSON.stringify(before)),
        this.crypto.checksum(JSON.stringify(after)),
        JSON.stringify({ impact }),
      ],
    );
  }

  private async auditSuccessor(
    manager: EntityManager,
    actor: Actor,
    requestId: string,
    draftId: string,
    sourceRevisionId: string,
    featureCount: number,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO audit_logs(
         actor_id,actor_role,action,resource_type,resource_id,request_id,metadata
       ) VALUES($1,$2,'revision.successor_created','revision',$3,$4,$5::jsonb)`,
      [
        actor.id,
        actor.role,
        draftId,
        requestId,
        JSON.stringify({ sourceRevisionId, featureCount }),
      ],
    );
  }

  private jsonObject(value: object): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }

  private replayed<T>(response: T | null): T {
    if (!response) throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
    return response;
  }
}
