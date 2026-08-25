import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import type { GeometryKind, ImportFormat } from '../domain/enums';
import {
  IMPORT_APPLY_JOB,
  IMPORT_INSPECT_JOB,
  IMPORT_QUEUE,
  IMPORT_VALIDATE_JOB,
} from '../jobs/jobs.constants';
import { GeometryService } from '../layers/geometry.service';
import type { LayerFieldDto } from '../layers/layer.dto';
import { LayerSchemaService } from '../layers/layer-schema.service';
import { ChangeFeedRetentionService } from '../layers/change-feed-retention.service';
import { StorageService } from '../storage/storage.service';
import { MAX_IMPORT_BYTES } from './import-file.inspector';
import { ImportJobEntity } from './import.entity';
import {
  ImportParserError,
  inspectXlsxSheets,
  parseImportRecords,
  parseWktGeometry,
  type ImportParserFailureCode,
} from './import-record.parser';

const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_VERTICES_PER_FEATURE = 100_000;
const MAX_VERTICES_PER_JOB = 2_000_000;
const MAX_ISSUES = 20_000;
const GEOJSON_GEOMETRY_TYPES = new Set([
  'GeometryCollection',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

type InspectionFailureCode =
  | 'IMPORT_OBJECT_SIZE_MISMATCH'
  | 'IMPORT_OBJECT_TOO_LARGE'
  | 'XLSX_INVALID'
  | 'XLSX_ZIP64_UNSUPPORTED'
  | 'IMPORT_EXPANDED_SIZE_LIMIT'
  | 'GEOJSON_INVALID'
  | 'IMPORT_RECORD_LIMIT'
  | 'IMPORT_FEATURE_VERTEX_LIMIT'
  | 'IMPORT_VERTEX_LIMIT'
  | ImportParserFailureCode;

class ImportInspectionError extends Error {
  constructor(readonly code: InspectionFailureCode) {
    super(code);
  }
}

interface ImportMappingPlan {
  sourceCrs: 'EPSG:4326';
  sheet?: string;
  encoding?: 'utf8' | 'utf16le' | 'windows1258' | 'latin1';
  delimiter?: 'comma' | 'semicolon' | 'tab' | 'pipe';
  geometry: {
    kind: 'coordinates' | 'wkt' | 'geojson' | 'kml_geometry';
    longitudeColumn?: string;
    latitudeColumn?: string;
    geometryColumn?: string;
  };
  fields: Record<string, string>;
  upsert?: { matchBy: 'feature_id' | 'external_identity' };
}

interface StagedFeature {
  rowNumber: number;
  proposedFeatureId: string;
  targetFeatureId: string | null;
  geometry: Record<string, unknown>;
  geometryKind: GeometryKind;
  radiusM: number | null;
  properties: Record<string, unknown>;
  externalSource: string | null;
  externalId: string | null;
  sourceFeatureId?: string | null;
}

const GEOJSON_KIND: Record<string, Exclude<GeometryKind, 'circle'>> = {
  Point: 'point',
  MultiPoint: 'multipoint',
  LineString: 'line',
  MultiLineString: 'multiline',
  Polygon: 'polygon',
  MultiPolygon: 'multipolygon',
};

@Processor(IMPORT_QUEUE, { concurrency: 2 })
export class ImportProcessor extends WorkerHost {
  constructor(
    @InjectRepository(ImportJobEntity) private readonly imports: Repository<ImportJobEntity>,
    private readonly storage: StorageService,
    private readonly dataSource: DataSource,
    private readonly geometryService: GeometryService,
    private readonly schemaService: LayerSchemaService,
    private readonly retention: ChangeFeedRetentionService,
  ) {
    super();
  }

  async process(job: Job<{ importId: string }>): Promise<void> {
    if (job.name === IMPORT_VALIDATE_JOB) return this.validate(job.data.importId);
    if (job.name === IMPORT_APPLY_JOB) return this.apply(job.data.importId);
    if (job.name !== IMPORT_INSPECT_JOB) return;
    const record = await this.imports.findOneBy({ id: job.data.importId });
    const isRetryableFailure =
      record?.status === 'failed' && record.failureCode === 'IMPORT_INSPECT_FAILED';
    if (!record || (!['uploaded', 'inspecting'].includes(record.status) && !isRetryableFailure)) {
      return;
    }
    await this.imports.update(record.id, { status: 'inspecting', progress: 10, failureCode: null });
    try {
      const stat = await this.storage.stat(record.objectKey);
      if (stat.size !== record.sizeBytes || stat.size < 1) {
        throw new ImportInspectionError('IMPORT_OBJECT_SIZE_MISMATCH');
      }
      if (stat.size > MAX_IMPORT_BYTES) throw new ImportInspectionError('IMPORT_OBJECT_TOO_LARGE');
      const content = await this.readBounded(record.objectKey);
      const counts = record.format === 'geojson' ? this.inspectGeoJson(content) : {};
      let sheets: string[] | undefined;
      if (record.format === 'xlsx') {
        this.enforceZipExpansion(content);
        sheets = await inspectXlsxSheets(content);
      }
      await this.imports.update(record.id, {
        status: 'mapping_required',
        progress: 100,
        counts,
        mapping: {
          ...record.mapping,
          inspection: {
            parserStatus: 'inspected',
            sheets,
            maxRecords: MAX_RECORDS,
            maxVerticesPerFeature: MAX_VERTICES_PER_FEATURE,
            maxVerticesPerJob: MAX_VERTICES_PER_JOB,
            maxExpandedBytes: MAX_EXPANDED_BYTES,
            maxIssues: 20_000,
          },
        },
      });
    } catch (error) {
      const failureCode =
        error instanceof ImportInspectionError || error instanceof ImportParserError
          ? error.code
          : 'IMPORT_INSPECT_FAILED';
      await this.imports.update(record.id, { status: 'failed', failureCode });
      if (error instanceof ImportInspectionError || error instanceof ImportParserError) {
        throw new UnrecoverableError(error.code);
      }
      throw error;
    }
  }

  private async validate(importId: string): Promise<void> {
    const record = await this.imports.findOneBy({ id: importId });
    if (!record || record.status !== 'validating') return;
    const plan = record.mapping.plan as ImportMappingPlan | undefined;
    if (!plan || plan.sourceCrs !== 'EPSG:4326') {
      await this.imports.update(record.id, {
        status: 'failed',
        failureCode: 'IMPORT_MAPPING_INVALID',
      });
      throw new UnrecoverableError('IMPORT_MAPPING_INVALID');
    }
    try {
      const content = await this.readBounded(record.objectKey);
      if (record.format === 'xlsx') this.enforceZipExpansion(content);
      const sourceFeatures = await parseImportRecords(content, record.format, plan, MAX_RECORDS);
      const revisionRows = (await this.dataSource.query(
        `SELECT r.layer_id AS "layerId",r.allowed_geometry_kinds AS "allowedKinds"
         FROM layer_revisions r WHERE r.id=$1 AND r.status='draft'`,
        [record.revisionId],
      )) as Array<{ layerId: string; allowedKinds: GeometryKind[] }>;
      const revision = revisionRows[0];
      if (!revision) throw new ImportInspectionError('GEOJSON_INVALID');
      const fields = (await this.dataSource.query(
        `SELECT key,type,required FROM layer_fields WHERE revision_id=$1 ORDER BY display_order,id`,
        [record.revisionId],
      )) as LayerFieldDto[];
      const existingRows = (await this.dataSource.query(
        `SELECT id,external_source AS "externalSource",external_id AS "externalId"
         FROM features WHERE layer_id=$1 AND deleted_at IS NULL`,
        [revision.layerId],
      )) as Array<{ id: string; externalSource: string | null; externalId: string | null }>;
      const existingByIdentity = new Map(
        existingRows
          .filter((feature) => feature.externalSource && feature.externalId)
          .map((feature) => [`${feature.externalSource}\u0000${feature.externalId}`, feature.id]),
      );
      const staged: StagedFeature[] = [];
      const issues: Array<{
        rowNumber: number;
        severity: 'warning' | 'error';
        code: string;
        field: string | null;
      }> = [];
      const mappedCandidates: StagedFeature[] = [];
      for (let index = 0; index < sourceFeatures.length; index += 1) {
        try {
          mappedCandidates.push(
            this.mapFeature(sourceFeatures[index], index + 1, plan, record.format),
          );
        } catch (error) {
          issues.push({
            rowNumber: index + 1,
            severity: 'error',
            code:
              error instanceof AppException || error instanceof ImportParserError
                ? error.code
                : 'IMPORT_ROW_INVALID',
            field: null,
          });
        }
      }
      const sourceFeatureIds = [
        ...new Set(
          mappedCandidates
            .map((candidate) => candidate.sourceFeatureId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const featureOwnerRows = sourceFeatureIds.length
        ? ((await this.dataSource.query(
            `SELECT id,layer_id AS "layerId",deleted_at AS "deletedAt"
             FROM features WHERE id=ANY($1::uuid[])`,
            [sourceFeatureIds],
          )) as Array<{ id: string; layerId: string; deletedAt: Date | null }>)
        : [];
      const featureOwners = new Map(featureOwnerRows.map((feature) => [feature.id, feature]));
      const seenIdentities = new Set<string>();
      const seenFeatureIds = new Set<string>();
      let matched = 0;
      let totalVertices = 0;
      for (const candidate of mappedCandidates) {
        const rowNumber = candidate.rowNumber;
        try {
          const featureVertices = this.countGeometryVertices(candidate.geometry);
          if (featureVertices > MAX_VERTICES_PER_FEATURE) {
            throw new ImportInspectionError('IMPORT_FEATURE_VERTEX_LIMIT');
          }
          totalVertices += featureVertices;
          if (totalVertices > MAX_VERTICES_PER_JOB) {
            throw new ImportInspectionError('IMPORT_VERTEX_LIMIT');
          }
          if (!revision.allowedKinds.includes(candidate.geometryKind)) {
            throw new AppException(
              422,
              'GEOMETRY_TYPE_NOT_ALLOWED',
              'Geometry không thuộc allow-list.',
            );
          }
          await this.geometryService.validate(
            candidate.geometry,
            candidate.geometryKind,
            candidate.radiusM,
          );
          this.schemaService.validateProperties(fields, candidate.properties);
          let targetFeatureId: string | null = null;
          if (plan.upsert?.matchBy === 'feature_id') {
            if (!candidate.sourceFeatureId) {
              throw new AppException(
                422,
                'IMPORT_FEATURE_ID_REQUIRED',
                'Dòng upsert thiếu feature_id.',
              );
            }
            if (seenFeatureIds.has(candidate.sourceFeatureId)) {
              throw new AppException(
                422,
                'IMPORT_DUPLICATE_FEATURE_ID',
                'feature_id bị trùng trong file.',
              );
            }
            seenFeatureIds.add(candidate.sourceFeatureId);
            const owner = featureOwners.get(candidate.sourceFeatureId);
            if (owner && owner.layerId !== revision.layerId) {
              throw new AppException(
                422,
                'IMPORT_FEATURE_ID_WRONG_LAYER',
                'feature_id thuộc layer khác.',
              );
            }
            if (owner?.deletedAt) {
              throw new AppException(422, 'IMPORT_FEATURE_ID_DELETED', 'feature_id đã bị xóa.');
            }
            if (owner) targetFeatureId = owner.id;
          }
          if (candidate.externalSource && candidate.externalId) {
            const identity = `${candidate.externalSource}\u0000${candidate.externalId}`;
            if (seenIdentities.has(identity)) {
              throw new AppException(
                422,
                'IMPORT_DUPLICATE_EXTERNAL_IDENTITY',
                'External identity bị trùng trong file.',
              );
            }
            seenIdentities.add(identity);
            const existing = existingByIdentity.get(identity);
            if (existing) {
              if (record.mode === 'append') {
                throw new AppException(
                  422,
                  'IMPORT_EXTERNAL_IDENTITY_EXISTS',
                  'External identity đã tồn tại.',
                );
              }
              if (plan.upsert?.matchBy === 'feature_id' && targetFeatureId !== existing) {
                throw new AppException(
                  422,
                  'IMPORT_EXTERNAL_IDENTITY_EXISTS',
                  'External identity thuộc feature khác.',
                );
              }
              targetFeatureId = existing;
            }
          } else if (plan.upsert?.matchBy === 'external_identity') {
            throw new AppException(
              422,
              'IMPORT_EXTERNAL_IDENTITY_REQUIRED',
              'Dòng upsert thiếu external identity.',
            );
          }
          if (targetFeatureId) matched += 1;
          staged.push({ ...candidate, targetFeatureId });
        } catch (error) {
          if (error instanceof ImportInspectionError) throw error;
          issues.push({
            rowNumber,
            severity: 'error',
            code: error instanceof AppException ? error.code : 'IMPORT_ROW_INVALID',
            field: null,
          });
        }
      }
      const errors = issues.filter((issue) => issue.severity === 'error');
      const warnings = issues.filter((issue) => issue.severity === 'warning');
      const reportKey = `reports/imports/${record.id}/validation.json`;
      await this.storage.putBuffer(
        reportKey,
        Buffer.from(JSON.stringify({ importId: record.id, issues })),
        'application/json',
      );
      await this.dataSource.transaction(async (manager) => {
        await manager.query('DELETE FROM import_staged_features WHERE import_id=$1', [record.id]);
        await manager.query('DELETE FROM import_issues WHERE import_id=$1', [record.id]);
        for (const feature of staged) {
          await manager.query(
            `INSERT INTO import_staged_features(
              import_id,row_number,proposed_feature_id,target_feature_id,geometry,geometry_kind,
              radius_m,properties,external_source,external_id
             ) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10)`,
            [
              record.id,
              feature.rowNumber,
              feature.proposedFeatureId,
              feature.targetFeatureId,
              JSON.stringify(feature.geometry),
              feature.geometryKind,
              feature.radiusM,
              JSON.stringify(feature.properties),
              feature.externalSource,
              feature.externalId,
            ],
          );
        }
        for (const issue of issues.slice(0, MAX_ISSUES)) {
          await manager.query(
            `INSERT INTO import_issues(import_id,row_number,severity,code,field)
             VALUES($1,$2,$3,$4,$5)`,
            [record.id, issue.rowNumber, issue.severity, issue.code, issue.field],
          );
        }
        await manager.update(ImportJobEntity, record.id, {
          status: 'ready',
          progress: 100,
          failureCode: null,
          counts: {
            total: sourceFeatures.length,
            valid: staged.length,
            warning: warnings.length,
            invalid: errors.length,
            matched,
            new: staged.length - matched,
          },
          mapping: {
            ...record.mapping,
            validation: {
              reportObjectKey: reportKey,
              persistedIssues: Math.min(issues.length, MAX_ISSUES),
            },
          },
        });
      });
    } catch (error) {
      const failureCode =
        error instanceof ImportInspectionError || error instanceof ImportParserError
          ? error.code
          : 'IMPORT_VALIDATE_FAILED';
      await this.imports.update(record.id, { status: 'failed', failureCode });
      throw new UnrecoverableError(failureCode);
    }
  }

  private async apply(importId: string): Promise<void> {
    const record = await this.imports.findOneBy({ id: importId });
    if (!record || record.status !== 'applying') return;
    const command = record.mapping.apply as
      | {
          expectedVersion: number;
          skipInvalid: boolean;
          requestId: string;
          actorRole: string;
        }
      | undefined;
    if (!command) return;
    try {
      await this.dataSource.transaction(async (manager) => {
        const job = await manager
          .getRepository(ImportJobEntity)
          .createQueryBuilder('job')
          .setLock('pessimistic_write')
          .where('job.id=:id', { id: record.id })
          .getOne();
        if (!job || job.status === 'completed') return;
        if (job.status !== 'applying') throw new Error('IMPORT_STATE_INVALID');
        if (Number(job.counts.invalid ?? 0) > 0 && !command.skipInvalid) {
          throw new Error('IMPORT_HAS_ERRORS');
        }
        const revisionRows = (await manager.query(
          `SELECT id,layer_id AS "layerId",lock_version AS "lockVersion",cursor_seq AS "cursorSeq",status
           FROM layer_revisions WHERE id=$1 FOR UPDATE`,
          [job.revisionId],
        )) as Array<{
          id: string;
          layerId: string;
          lockVersion: number;
          cursorSeq: string;
          status: string;
        }>;
        const revision = revisionRows[0];
        if (!revision || revision.status !== 'draft') throw new Error('REVISION_NOT_EDITABLE');
        if (revision.lockVersion !== command.expectedVersion) throw new Error('ETAG_MISMATCH');
        const staged = (await manager.query(
          `SELECT row_number AS "rowNumber",proposed_feature_id AS "proposedFeatureId",
                  target_feature_id AS "targetFeatureId",geometry,geometry_kind AS "geometryKind",
                  radius_m AS "radiusM",properties,external_source AS "externalSource",
                  external_id AS "externalId"
           FROM import_staged_features WHERE import_id=$1 ORDER BY row_number`,
          [job.id],
        )) as StagedFeature[];
        if (staged.length < 1) throw new Error('IMPORT_NO_VALID_ROWS');
        let nextCursor = BigInt(revision.cursorSeq);
        if (job.mode === 'replace') {
          const removed = (await manager.query(
            `SELECT feature_id AS "featureId" FROM revision_features
             WHERE revision_id=$1 ORDER BY ordinal,feature_id`,
            [job.revisionId],
          )) as Array<{ featureId: string }>;
          await manager.query('DELETE FROM revision_features WHERE revision_id=$1', [
            job.revisionId,
          ]);
          for (const feature of removed) {
            nextCursor += 1n;
            await manager.query(
              `INSERT INTO revision_changes(
                 revision_id,server_cursor,operation,feature_id,version_id,changed_paths,actor_id
               ) VALUES($1,$2,'delete',$3,NULL,ARRAY[]::text[],$4)`,
              [job.revisionId, nextCursor.toString(), feature.featureId, job.actorId],
            );
          }
        }
        for (const feature of staged) {
          nextCursor += 1n;
          const featureId = feature.targetFeatureId ?? feature.proposedFeatureId;
          if (!feature.targetFeatureId) {
            await manager.query(
              `INSERT INTO features(id,layer_id,external_source,external_id)
               VALUES($1,$2,$3,$4)`,
              [featureId, revision.layerId, feature.externalSource, feature.externalId],
            );
          } else if (feature.externalSource && feature.externalId) {
            await manager.query(
              `UPDATE features SET external_source=$2,external_id=$3
               WHERE id=$1 AND layer_id=$4`,
              [featureId, feature.externalSource, feature.externalId, revision.layerId],
            );
          }
          const checksum = createHash('sha256')
            .update(JSON.stringify([feature.geometry, feature.properties, feature.radiusM]))
            .digest('hex');
          const versionId = randomUUID();
          await manager.query(
            `INSERT INTO feature_versions(
              id,feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by
             ) VALUES($1,$2,$3,ST_SetSRID(ST_GeomFromGeoJSON($4),4326),$5,$6::jsonb,$7,$8,$9)`,
            [
              versionId,
              featureId,
              job.revisionId,
              JSON.stringify(feature.geometry),
              feature.geometryKind,
              JSON.stringify(feature.properties),
              feature.radiusM,
              checksum,
              job.actorId,
            ],
          );
          await manager.query(
            `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
             VALUES($1,$2,$3,$4)
             ON CONFLICT(revision_id,feature_id) DO UPDATE SET
               feature_version_id=EXCLUDED.feature_version_id,ordinal=EXCLUDED.ordinal`,
            [job.revisionId, featureId, versionId, feature.rowNumber],
          );
          await manager.query(
            `INSERT INTO revision_changes(
              revision_id,server_cursor,operation,feature_id,version_id,changed_paths,actor_id
             ) VALUES($1,$2,$3,$4,$5,ARRAY['geometry','properties'],$6)`,
            [
              job.revisionId,
              nextCursor.toString(),
              feature.targetFeatureId ? 'update' : 'create',
              featureId,
              versionId,
              job.actorId,
            ],
          );
        }
        await manager.query(
          `UPDATE layer_revisions SET lock_version=lock_version+1,cursor_seq=$2,updated_at=now()
           WHERE id=$1`,
          [job.revisionId, nextCursor.toString()],
        );
        await this.retention.prune(manager, job.revisionId, Number(nextCursor));
        await manager.query(
          `INSERT INTO revision_participants(revision_id,user_id,participation_type)
           VALUES($1,$2,'edit') ON CONFLICT DO NOTHING`,
          [job.revisionId, job.actorId],
        );
        await manager.query(
          `INSERT INTO audit_logs(
            actor_id,actor_role,action,resource_type,resource_id,request_id,metadata
           ) VALUES($1,$2,'import.applied','import_job',$3,$4,$5::jsonb)`,
          [
            job.actorId,
            command.actorRole,
            job.id,
            command.requestId,
            JSON.stringify({ revisionId: job.revisionId, mode: job.mode, applied: staged.length }),
          ],
        );
        await manager.update(ImportJobEntity, job.id, {
          status: 'completed',
          progress: 100,
          counts: {
            ...job.counts,
            applied: staged.length,
            skipped: command.skipInvalid ? Number(job.counts.invalid ?? 0) : 0,
          },
          failureCode: null,
        });
      });
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          'ETAG_MISMATCH',
          'REVISION_NOT_EDITABLE',
          'IMPORT_NO_VALID_ROWS',
          'IMPORT_HAS_ERRORS',
        ].includes(error.message)
          ? error.message
          : 'IMPORT_APPLY_FAILED';
      await this.imports.update(record.id, { status: 'failed', failureCode: code });
      throw new UnrecoverableError(code);
    }
  }

  private mapFeature(
    value: unknown,
    rowNumber: number,
    plan: ImportMappingPlan,
    format: ImportFormat,
  ): StagedFeature {
    if (!value || typeof value !== 'object') {
      throw new AppException(422, 'IMPORT_ROW_INVALID', 'Dòng import không hợp lệ.');
    }
    let geometry: Record<string, unknown>;
    let sourceProperties: Record<string, unknown>;
    let declaredGeometryKind: unknown;
    let declaredRadiusM: unknown;
    if (format === 'csv' || format === 'xlsx') {
      if (Array.isArray(value)) {
        throw new AppException(422, 'IMPORT_ROW_INVALID', 'Dòng import không hợp lệ.');
      }
      sourceProperties = value as Record<string, unknown>;
      if (plan.geometry.kind === 'coordinates') {
        const longitude = Number(sourceProperties[plan.geometry.longitudeColumn ?? '']);
        const latitude = Number(sourceProperties[plan.geometry.latitudeColumn ?? '']);
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
          throw new AppException(
            422,
            'IMPORT_COORDINATES_INVALID',
            'Tọa độ longitude/latitude không hợp lệ.',
          );
        }
        geometry = { type: 'Point', coordinates: [longitude, latitude] };
      } else if (plan.geometry.kind === 'wkt') {
        geometry = parseWktGeometry(sourceProperties[plan.geometry.geometryColumn ?? '']);
      } else {
        throw new AppException(422, 'IMPORT_MAPPING_INVALID', 'Geometry mapping không hợp lệ.');
      }
    } else {
      const feature = value as {
        id?: unknown;
        type?: unknown;
        geometry?: unknown;
        properties?: unknown;
        geometryKind?: unknown;
        radiusM?: unknown;
      };
      if (
        feature.type !== 'Feature' ||
        !feature.geometry ||
        typeof feature.geometry !== 'object' ||
        (feature.properties !== null &&
          (typeof feature.properties !== 'object' || Array.isArray(feature.properties)))
      ) {
        throw new AppException(422, 'GEOJSON_FEATURE_INVALID', 'Feature không hợp lệ.');
      }
      geometry = feature.geometry as Record<string, unknown>;
      sourceProperties = { ...((feature.properties ?? {}) as Record<string, unknown>) };
      if (feature.id !== undefined && sourceProperties.feature_id === undefined) {
        sourceProperties.feature_id = feature.id;
      }
      declaredGeometryKind = feature.geometryKind;
      declaredRadiusM = feature.radiusM;
    }
    const inferredKind = GEOJSON_KIND[String(geometry.type)];
    const geometryKind =
      declaredGeometryKind === 'circle'
        ? 'circle'
        : declaredGeometryKind === undefined
          ? inferredKind
          : (declaredGeometryKind as GeometryKind);
    if (!geometryKind || (!GEOJSON_KIND[String(geometry.type)] && geometryKind !== 'circle')) {
      throw new AppException(422, 'GEOMETRY_TYPE_NOT_ALLOWED', 'Geometry type không được hỗ trợ.');
    }
    const radiusM =
      declaredRadiusM === undefined || declaredRadiusM === null ? null : Number(declaredRadiusM);
    const properties: Record<string, unknown> = {};
    let externalSource: string | null = null;
    let externalId: string | null = null;
    let sourceFeatureId: string | null = null;
    for (const [source, target] of Object.entries(plan.fields)) {
      const mapped = sourceProperties[source];
      if (target === 'external_source') {
        externalSource = this.importIdentifier(mapped);
      } else if (target === 'external_id') {
        externalId = this.importIdentifier(mapped);
      } else if (target === 'feature_id') {
        const identifier = this.importIdentifier(mapped);
        if (identifier && !this.isUuid(identifier)) {
          throw new AppException(422, 'IMPORT_FEATURE_ID_INVALID', 'feature_id không phải UUID.');
        }
        sourceFeatureId = identifier;
      } else if (mapped !== undefined) {
        properties[target] = mapped;
      }
    }
    if ((externalSource === null) !== (externalId === null)) {
      throw new AppException(
        422,
        'IMPORT_EXTERNAL_IDENTITY_INCOMPLETE',
        'External identity cần đủ source và id.',
      );
    }
    if (Buffer.byteLength(JSON.stringify(properties), 'utf8') > 64 * 1024) {
      throw new AppException(422, 'IMPORT_PROPERTIES_TOO_LARGE', 'Properties vượt quá 64 KiB.');
    }
    return {
      rowNumber,
      proposedFeatureId: randomUUID(),
      targetFeatureId: null,
      geometry,
      geometryKind,
      radiusM,
      properties,
      externalSource,
      externalId,
      sourceFeatureId,
    };
  }

  private importIdentifier(value: unknown): string | null {
    if (!['string', 'number'].includes(typeof value)) return null;
    const normalized = String(value).trim();
    return normalized ? normalized : null;
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private async readBounded(key: string): Promise<Buffer> {
    const stream = await this.storage.getObject(key);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_IMPORT_BYTES) {
        stream.destroy();
        throw new ImportInspectionError('IMPORT_OBJECT_TOO_LARGE');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }

  private enforceZipExpansion(content: Buffer): void {
    let offset = 0;
    let entries = 0;
    let expandedBytes = 0;
    while (offset + 46 <= content.byteLength) {
      if (content.readUInt32LE(offset) !== 0x02014b50) {
        offset += 1;
        continue;
      }
      const uncompressed = content.readUInt32LE(offset + 24);
      if (uncompressed === 0xffffffff) throw new ImportInspectionError('XLSX_ZIP64_UNSUPPORTED');
      expandedBytes += uncompressed;
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new ImportInspectionError('IMPORT_EXPANDED_SIZE_LIMIT');
      }
      const nameLength = content.readUInt16LE(offset + 28);
      const extraLength = content.readUInt16LE(offset + 30);
      const commentLength = content.readUInt16LE(offset + 32);
      entries += 1;
      offset += 46 + nameLength + extraLength + commentLength;
    }
    if (entries === 0) throw new ImportInspectionError('XLSX_INVALID');
  }

  private inspectGeoJson(content: Buffer): Record<string, number> {
    let payload: unknown;
    try {
      payload = JSON.parse(content.toString('utf8'));
    } catch {
      throw new ImportInspectionError('GEOJSON_INVALID');
    }
    const features = this.features(payload);
    if (features.length > MAX_RECORDS) throw new ImportInspectionError('IMPORT_RECORD_LIMIT');
    let vertices = 0;
    for (const feature of features) {
      const featureVertices = this.countGeometryVertices(feature);
      if (featureVertices > MAX_VERTICES_PER_FEATURE) {
        throw new ImportInspectionError('IMPORT_FEATURE_VERTEX_LIMIT');
      }
      vertices += featureVertices;
      if (vertices > MAX_VERTICES_PER_JOB) throw new ImportInspectionError('IMPORT_VERTEX_LIMIT');
    }
    return { total: features.length, vertices };
  }

  private features(value: unknown): unknown[] {
    if (!value || typeof value !== 'object') throw new ImportInspectionError('GEOJSON_INVALID');
    const record = value as { type?: unknown; features?: unknown };
    if (record.type === 'FeatureCollection') {
      if (!Array.isArray(record.features)) throw new ImportInspectionError('GEOJSON_INVALID');
      return record.features;
    }
    if (record.type === 'Feature' || GEOJSON_GEOMETRY_TYPES.has(String(record.type)))
      return [value];
    throw new ImportInspectionError('GEOJSON_INVALID');
  }

  private countGeometryVertices(value: unknown): number {
    if (!value || typeof value !== 'object') return 0;
    const record = value as { geometry?: unknown; geometries?: unknown; coordinates?: unknown };
    if (record.geometry) return this.countGeometryVertices(record.geometry);
    if (Array.isArray(record.geometries)) {
      let total = 0;
      for (const geometry of record.geometries as unknown[]) {
        total += this.countGeometryVertices(geometry);
      }
      return total;
    }
    return this.countCoordinates(record.coordinates);
  }

  private countCoordinates(value: unknown): number {
    if (!Array.isArray(value)) return 0;
    if (value.length >= 2 && value.every((coordinate) => typeof coordinate === 'number')) return 1;
    let total = 0;
    for (const item of value as unknown[]) total += this.countCoordinates(item);
    return total;
  }
}
