import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { canonicalPublicFieldSql } from '../common/public-field.policy';
import { publicationPointerEtag } from '../layers/etag';
import type {
  AuditHistoryQueryDto,
  PublicationHistoryQueryDto,
  RevisionDiffQueryDto,
  RevisionHistoryQueryDto,
  WorkflowHistoryQueryDto,
} from './history.dto';

interface Actor {
  id: string;
  role: string;
}

interface NumericPageCursor {
  value: number;
}

interface AuditPageCursor {
  occurredAt: string;
  id: string;
}

interface FeatureDiffCursor {
  featureId: string;
}

const CONTENT_RESOURCE_TYPES = [
  'layer',
  'layer_group',
  'layer_revision',
  'revision',
  'feature',
  'import_job',
  'publication',
];

const DIFF_MAX_FEATURES_PER_SIDE = 25_000;
const DIFF_MAX_TOTAL_VERTICES = 2_000_000;

const LAYER_AUDIT_ACTION_PATTERNS: Record<string, readonly string[]> = {
  editor: [
    'feature.%',
    'import.%',
    'layer.%',
    'layer_group.%',
    'revision.config_updated',
    'revision.successor_created',
    'revision.submitted',
  ],
  reviewer: [
    'revision.submitted',
    'revision.approved',
    'revision.changes_requested',
    'revision.published',
    'publication.queued',
    'publication.failed',
    'publication.rolled_back',
  ],
  publisher: [
    'revision.submitted',
    'revision.approved',
    'revision.changes_requested',
    'revision.published',
    'publication.queued',
    'publication.failed',
    'publication.rolled_back',
  ],
};

const CONTENT_AUDIT_METADATA_KEYS = new Set([
  'activeRevisionId',
  'activeSnapshotId',
  'affectedFeatures',
  'after',
  'applied',
  'archivedAt',
  'before',
  'blocking',
  'changed',
  'clientIntent',
  'comment',
  'count',
  'defaultVisible',
  'displayOrder',
  'draftRevisionId',
  'featureCount',
  'failureCode',
  'fieldKey',
  'generation',
  'geometryKind',
  'groupId',
  'id',
  'impact',
  'items',
  'jobId',
  'layerId',
  'lockVersion',
  'mode',
  'orphanLayerPolicy',
  'orderDigest',
  'publicCacheVersion',
  'reason',
  'reasons',
  'releaseNote',
  'reviewerNote',
  'revisionId',
  'schemaVersionWillIncrement',
  'skipped',
  'sourceRevisionId',
  'successorRevisionId',
  'summary',
  'targetGeneration',
  'targetSnapshotId',
  'title',
  'ungroupedLayerCount',
  'ungroupedLayerIdsDigest',
  'updatedCount',
]);

const SYSTEM_AUDIT_METADATA_KEYS = new Set([
  ...CONTENT_AUDIT_METADATA_KEYS,
  'assignedRole',
  'delivery',
  'expiresAt',
  'inviteId',
  'method',
  'recoveryCodeCount',
  'revokedCount',
  'role',
  'rowNumber',
  'sessionCount',
  'status',
  'userId',
]);

const AUDIT_ACTION_METADATA_KEYS: Record<string, readonly string[]> = {
  'feature.created': ['revisionId'],
  'feature.deleted': ['revisionId'],
  'feature.updated': ['revisionId'],
  'import.applied': ['revisionId', 'mode', 'applied'],
  'layer.created': ['revisionId'],
  'layer.updated': ['before', 'after'],
  'layer.reordered': ['before', 'after'],
  'layer.archived': ['before', 'after'],
  'layer.unarchived': ['before', 'after'],
  'layer_group.updated': ['before', 'after'],
  'layer_group.reordered': ['before', 'after'],
  'layer_group.archived': [
    'before',
    'after',
    'orphanLayerPolicy',
    'ungroupedLayerCount',
    'ungroupedLayerIdsDigest',
  ],
  'publication.rolled_back': [
    'layerId',
    'targetSnapshotId',
    'targetGeneration',
    'activeSnapshotId',
    'activeRevisionId',
    'generation',
    'reason',
    'clientIntent',
    'publicCacheVersion',
  ],
  'publication.queued': ['jobId', 'layerId', 'revisionId', 'clientIntent'],
  'publication.failed': ['jobId', 'layerId', 'revisionId', 'failureCode'],
  'revision.approved': ['comment'],
  'revision.changes_requested': ['comment', 'successorRevisionId'],
  'revision.config_updated': ['impact'],
  'revision.published': ['snapshotId', 'generation', 'releaseNote'],
  'revision.submitted': ['summary', 'reviewerNote'],
  'revision.successor_created': ['sourceRevisionId', 'featureCount'],
  'auth.login_succeeded': ['method'],
  'auth.mfa_enrollment_confirmed': ['recoveryCodeCount'],
  'invite.created': ['delivery', 'role', 'expiresAt'],
  'invite.revoked': ['reason'],
  'user.created_from_invite': ['inviteId', 'role'],
  'user.created_manual': ['role'],
  'user_import.applied': ['applied', 'skipped'],
  'user_import.apply_rejected': ['failureCode', 'skipped'],
  'user_import.invite_created': ['jobId', 'rowNumber', 'assignedRole'],
};

@Injectable()
export class HistoryQueryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly crypto: CryptoService,
  ) {}

  async listRevisionHistory(layerId: string, query: RevisionHistoryQueryDto) {
    await this.assertLayer(layerId);
    const cursor = query.cursor ? this.decodeNumericCursor(query.cursor) : null;
    const rows = (await this.dataSource.query(
      `SELECT revision.id,revision.revision_no AS "revisionNo",revision.status,revision.title,
              revision.supersedes_revision_id AS "supersedesRevisionId",
              revision.created_by AS "createdBy",creator.display_name AS "createdByDisplayName",
              revision.submitted_at AS "submittedAt",revision.approved_at AS "approvedAt",
              revision.published_at AS "publishedAt",revision.created_at AS "createdAt",
              revision.updated_at AS "updatedAt",
              (SELECT count(*)::integer FROM revision_features rf
               WHERE rf.revision_id=revision.id) AS "featureCount",
              (SELECT count(*)::integer FROM revision_participants participant
               WHERE participant.revision_id=revision.id) AS "participantCount",
              active_snapshot.id AS "activeSnapshotId",
              active_snapshot.generation::integer AS "activeGeneration"
       FROM layer_revisions revision
       LEFT JOIN users creator ON creator.id=revision.created_by
       LEFT JOIN layer_publications pointer ON pointer.layer_id=revision.layer_id
       LEFT JOIN publication_snapshots active_snapshot
         ON active_snapshot.id=pointer.active_snapshot_id AND active_snapshot.revision_id=revision.id
       WHERE revision.layer_id=$1
         AND ($2::text IS NULL OR revision.status=$2)
         AND ($3::integer IS NULL OR revision.revision_no < $3)
       ORDER BY revision.revision_no DESC
       LIMIT $4`,
      [layerId, query.status ?? null, cursor?.value ?? null, query.limit + 1],
    )) as Array<Record<string, unknown> & { revisionNo: number }>;
    const page = this.numericPage(rows, query.limit, (row) => Number(row.revisionNo));
    return this.versioned(page);
  }

  async getRevisionHistory(revisionId: string) {
    const revisions = (await this.dataSource.query(
      `SELECT revision.id,revision.layer_id AS "layerId",revision.revision_no AS "revisionNo",
              revision.status,revision.title,revision.description,
              revision.geometry_mode AS "geometryMode",
              revision.allowed_geometry_kinds AS "allowedGeometryKinds",
              revision.schema_version AS "schemaVersion",revision.lock_version AS "lockVersion",
              revision.supersedes_revision_id AS "supersedesRevisionId",
              revision.created_by AS "createdBy",creator.display_name AS "createdByDisplayName",
              revision.submitted_at AS "submittedAt",revision.approved_at AS "approvedAt",
              revision.published_at AS "publishedAt",revision.created_at AS "createdAt",
              revision.updated_at AS "updatedAt",
              successor.id AS "successorRevisionId"
       FROM layer_revisions revision
       LEFT JOIN users creator ON creator.id=revision.created_by
       LEFT JOIN LATERAL (
         SELECT id FROM layer_revisions candidate
         WHERE candidate.supersedes_revision_id=revision.id
         ORDER BY candidate.revision_no LIMIT 1
       ) successor ON true
       WHERE revision.id=$1`,
      [revisionId],
    )) as Array<Record<string, unknown>>;
    const revision = revisions[0];
    if (!revision) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');

    const [participants, events, publications, validationRows] = await Promise.all([
      this.dataSource.query(
        `SELECT participant.user_id AS "userId",participant.participation_type AS "type",
                participant.participated_at AS "participatedAt",actor.display_name AS "displayName",
                actor.role
         FROM revision_participants participant
         LEFT JOIN users actor ON actor.id=participant.user_id
         WHERE participant.revision_id=$1
         ORDER BY participant.participated_at DESC,participant.user_id,participant.participation_type
         LIMIT 101`,
        [revisionId],
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT event.id,event.from_status AS "fromStatus",event.to_status AS "toStatus",
                event.actor_id AS "actorId",actor.display_name AS "actorDisplayName",actor.role,
                event.reason,event.occurred_at AS "occurredAt"
         FROM workflow_events event
         LEFT JOIN users actor ON actor.id=event.actor_id
         WHERE event.revision_id=$1
         ORDER BY event.occurred_at DESC,event.id DESC
         LIMIT 101`,
        [revisionId],
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT snapshot.id AS "snapshotId",snapshot.generation::integer AS generation,
                snapshot.status,snapshot.feature_count AS "featureCount",snapshot.published_at AS "publishedAt",
                snapshot.manifest->>'rollbackOf' AS "rollbackOf",
                (pointer.active_snapshot_id=snapshot.id) AS "isActive"
         FROM publication_snapshots snapshot
         LEFT JOIN layer_publications pointer ON pointer.layer_id=snapshot.layer_id
         WHERE snapshot.revision_id=$1
         ORDER BY snapshot.generation DESC
         LIMIT 101`,
        [revisionId],
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT count(*)::integer AS "featureCount",
                count(*) FILTER (WHERE NOT ST_IsValid(version.geometry))::integer AS "invalidGeometryCount",
                count(*) FILTER (
                  WHERE EXISTS (
                    SELECT 1 FROM layer_fields field
                    WHERE field.revision_id=$1 AND field.required
                      AND (NOT (version.properties ? field.key) OR version.properties->field.key='null'::jsonb)
                  )
                )::integer AS "missingRequiredPropertyCount"
         FROM revision_features member
         JOIN feature_versions version ON version.id=member.feature_version_id
         WHERE member.revision_id=$1`,
        [revisionId],
      ) as Promise<
        Array<{
          featureCount: number;
          invalidGeometryCount: number;
          missingRequiredPropertyCount: number;
        }>
      >,
    ]);
    const validation = validationRows[0] ?? {
      featureCount: 0,
      invalidGeometryCount: 0,
      missingRequiredPropertyCount: 0,
    };
    const issues = [
      {
        code: 'GEOMETRY_INVALID',
        count: Number(validation.invalidGeometryCount),
      },
      {
        code: 'REQUIRED_PROPERTY_MISSING',
        count: Number(validation.missingRequiredPropertyCount),
      },
    ].filter((issue) => issue.count > 0);
    return this.versioned({
      revision,
      validation: {
        status: issues.length ? 'invalid' : 'valid',
        featureCount: Number(validation.featureCount),
        issues,
      },
      participants: participants.slice(0, 100),
      events: events.slice(0, 100),
      publications: publications.slice(0, 100),
      historyLimits: {
        participants: {
          returned: Math.min(participants.length, 100),
          hasMore: participants.length > 100,
          limit: 100,
        },
        events: {
          returned: Math.min(events.length, 100),
          hasMore: events.length > 100,
          limit: 100,
        },
        publications: {
          returned: Math.min(publications.length, 100),
          hasMore: publications.length > 100,
          limit: 100,
        },
      },
    });
  }

  async getRevisionDiff(revisionId: string, query: RevisionDiffQueryDto) {
    try {
      return await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
        await manager.query(`SET TRANSACTION READ ONLY`);
        await manager.query(`SET LOCAL statement_timeout = '8s'`);
        const identities = (await manager.query(
          `SELECT revision.id,revision.layer_id AS "layerId",
              CASE WHEN $2='parent' THEN revision.supersedes_revision_id ELSE active.revision_id END AS "baseRevisionId"
       FROM layer_revisions revision
       LEFT JOIN layer_publications pointer ON pointer.layer_id=revision.layer_id
       LEFT JOIN publication_snapshots active ON active.id=pointer.active_snapshot_id
       WHERE revision.id=$1`,
          [revisionId, query.compareTo],
        )) as Array<{ id: string; layerId: string; baseRevisionId: string | null }>;
        const identity = identities[0];
        if (!identity) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');

        const complexityRows = (await manager.query(
          `SELECT count(*) FILTER (WHERE member.revision_id=$1)::integer AS "currentFeatures",
              count(*) FILTER (WHERE member.revision_id=$2)::integer AS "baseFeatures",
              COALESCE(sum(ST_NPoints(version.geometry)),0)::bigint AS "totalVertices"
       FROM revision_features member
       JOIN feature_versions version ON version.id=member.feature_version_id
       WHERE member.revision_id=$1 OR member.revision_id=$2`,
          [revisionId, identity.baseRevisionId],
        )) as Array<{ currentFeatures: number; baseFeatures: number; totalVertices: string }>;
        const complexity = complexityRows[0] ?? {
          currentFeatures: 0,
          baseFeatures: 0,
          totalVertices: '0',
        };
        if (
          Number(complexity.currentFeatures) > DIFF_MAX_FEATURES_PER_SIDE ||
          Number(complexity.baseFeatures) > DIFF_MAX_FEATURES_PER_SIDE ||
          Number(complexity.totalVertices) > DIFF_MAX_TOTAL_VERTICES
        ) {
          throw new AppException(
            422,
            'DIFF_TOO_LARGE',
            'Revision diff vượt giới hạn xử lý đồng bộ.',
            {
              reason: 'COMPLEXITY_LIMIT',
              currentFeatures: Number(complexity.currentFeatures),
              baseFeatures: Number(complexity.baseFeatures),
              totalVertices: Number(complexity.totalVertices),
              maxFeaturesPerSide: DIFF_MAX_FEATURES_PER_SIDE,
              maxTotalVertices: DIFF_MAX_TOTAL_VERTICES,
              statementTimeoutMs: 8_000,
            },
          );
        }

        const featureRows = (await manager.query(
          `WITH public_keys AS (
           SELECT COALESCE(array_agg(key ORDER BY key),'{}'::text[]) AS keys
           FROM (
             SELECT field.key
             FROM layer_fields field
             WHERE field.revision_id IN ($1,$2)
             GROUP BY field.key
             HAVING bool_and(${canonicalPublicFieldSql('field')})
           ) safe
         ), current_features AS (
           SELECT member.feature_id,version.geometry,version.properties,version.radius_m
           FROM revision_features member JOIN feature_versions version ON version.id=member.feature_version_id
           WHERE member.revision_id=$1
         ), base_features AS (
           SELECT member.feature_id,version.geometry,version.properties,version.radius_m
           FROM revision_features member JOIN feature_versions version ON version.id=member.feature_version_id
           WHERE member.revision_id=$2
         ), compared AS (
           SELECT current_features.feature_id AS current_id,base_features.feature_id AS base_id,
                   current_features.geometry AS current_geometry,base_features.geometry AS base_geometry,
                   current_features.properties AS current_properties,base_features.properties AS base_properties,
                   current_features.radius_m AS current_radius_m,base_features.radius_m AS base_radius_m
           FROM current_features FULL JOIN base_features USING(feature_id)
         )
         SELECT count(*) FILTER (WHERE current_id IS NOT NULL)::integer AS "currentFeatureCount",
                count(*) FILTER (WHERE base_id IS NOT NULL)::integer AS "baseFeatureCount",
                count(*) FILTER (WHERE current_id IS NOT NULL AND base_id IS NULL)::integer AS added,
                count(*) FILTER (WHERE current_id IS NULL AND base_id IS NOT NULL)::integer AS removed,
                count(*) FILTER (
                  WHERE current_id IS NOT NULL AND base_id IS NOT NULL
                    AND (NOT ST_Equals(current_geometry,base_geometry)
                         OR current_radius_m IS DISTINCT FROM base_radius_m)
                )::integer AS "geometryModified",
                count(*) FILTER (
                  WHERE current_id IS NOT NULL AND base_id IS NOT NULL AND (
                    SELECT COALESCE(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb)
                    FROM jsonb_each(current_properties) entry, public_keys
                    WHERE entry.key=ANY(public_keys.keys)
                  ) IS DISTINCT FROM (
                    SELECT COALESCE(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb)
                    FROM jsonb_each(base_properties) entry, public_keys
                    WHERE entry.key=ANY(public_keys.keys)
                  )
                )::integer AS "propertiesModified"
          FROM compared`,
          [revisionId, identity.baseRevisionId],
        )) as Array<Record<string, unknown>>;
        const changedPropertyRows = (await manager.query(
          `WITH public_keys AS (
            SELECT field.key FROM layer_fields field
            WHERE field.revision_id IN ($1,$2)
            GROUP BY field.key
            HAVING bool_and(${canonicalPublicFieldSql('field')})
         ), compared AS (
           SELECT current_version.properties AS current_properties,
                  base_version.properties AS base_properties
           FROM revision_features current_member
           JOIN revision_features base_member ON base_member.feature_id=current_member.feature_id
             AND base_member.revision_id=$2
           JOIN feature_versions current_version ON current_version.id=current_member.feature_version_id
           JOIN feature_versions base_version ON base_version.id=base_member.feature_version_id
           WHERE current_member.revision_id=$1
         )
         SELECT COALESCE(array_agg(changed.key ORDER BY changed.key),'{}'::text[]) AS keys
         FROM (
           SELECT DISTINCT public_keys.key
           FROM public_keys CROSS JOIN compared
           WHERE compared.current_properties->public_keys.key
                 IS DISTINCT FROM compared.base_properties->public_keys.key
          ) changed`,
          [revisionId, identity.baseRevisionId],
        )) as Array<{ keys: string[] }>;
        const schemaRows = (await manager.query(
          `WITH current_fields AS (
           SELECT * FROM layer_fields WHERE revision_id=$1
         ), base_fields AS (
           SELECT * FROM layer_fields WHERE revision_id=$2
         ), compared AS (
           SELECT COALESCE(current_fields.key,base_fields.key) AS key,
                  current_fields.id AS current_id,base_fields.id AS base_id,
                   CASE
                     WHEN current_fields.id IS NULL THEN ${canonicalPublicFieldSql('base_fields')}
                     WHEN base_fields.id IS NULL THEN ${canonicalPublicFieldSql('current_fields')}
                     ELSE ${canonicalPublicFieldSql('current_fields')}
                       AND ${canonicalPublicFieldSql('base_fields')}
                   END AS safe_public,
                  (to_jsonb(current_fields)-'id'-'revision_id')
                    IS DISTINCT FROM (to_jsonb(base_fields)-'id'-'revision_id') AS changed
           FROM current_fields FULL JOIN base_fields USING(key)
         )
         SELECT COALESCE(array_agg(key ORDER BY key) FILTER (
                   WHERE current_id IS NOT NULL AND base_id IS NULL AND safe_public
                ),'{}'::text[]) AS added,
                COALESCE(array_agg(key ORDER BY key) FILTER (
                   WHERE current_id IS NULL AND base_id IS NOT NULL AND safe_public
                ),'{}'::text[]) AS removed,
                COALESCE(array_agg(key ORDER BY key) FILTER (
                   WHERE current_id IS NOT NULL AND base_id IS NOT NULL AND changed AND safe_public
                 ),'{}'::text[]) AS changed,
                 count(*) FILTER (WHERE changed AND NOT safe_public)::integer AS "redactedChangeCount"
          FROM compared`,
          [revisionId, identity.baseRevisionId],
        )) as Array<{
          added: string[];
          removed: string[];
          changed: string[];
          redactedChangeCount: number;
        }>;

        const feature = featureRows[0] ?? {};
        const propertyKeys = changedPropertyRows[0]?.keys ?? [];
        const schema = schemaRows[0] ?? {
          added: [],
          removed: [],
          changed: [],
          redactedChangeCount: 0,
        };
        const diffCursor = query.cursor ? this.decodeFeatureDiffCursor(query.cursor) : null;
        const entryRows = (await manager.query(
          `WITH safe_fields AS (
          SELECT field.key
          FROM layer_fields field
          WHERE field.revision_id IN ($1,$2)
          GROUP BY field.key
          HAVING bool_and(${canonicalPublicFieldSql('field')})
        ), current_features AS (
          SELECT member.feature_id,version.geometry,version.geometry_kind,
                 version.properties,version.radius_m,version.checksum
         FROM revision_features member JOIN feature_versions version ON version.id=member.feature_version_id
         WHERE member.revision_id=$1
       ), base_features AS (
         SELECT member.feature_id,version.geometry,version.geometry_kind,
                 version.properties,version.radius_m,version.checksum
         FROM revision_features member JOIN feature_versions version ON version.id=member.feature_version_id
         WHERE member.revision_id=$2
       ), compared AS (
         SELECT COALESCE(current_features.feature_id,base_features.feature_id) AS feature_id,
                current_features.feature_id AS current_id,base_features.feature_id AS base_id,
                current_features.geometry AS current_geometry,base_features.geometry AS base_geometry,
                current_features.geometry_kind AS current_geometry_kind,
                base_features.geometry_kind AS base_geometry_kind,
                 current_features.properties AS current_properties,
                 base_features.properties AS base_properties,
                 current_features.radius_m AS current_radius_m,
                 base_features.radius_m AS base_radius_m,
                current_features.checksum AS current_checksum,base_features.checksum AS base_checksum
         FROM current_features FULL JOIN base_features USING(feature_id)
       )
       SELECT compared.feature_id AS "featureId",compared.current_id AS "currentId",
              compared.base_id AS "baseId",compared.current_checksum AS "currentChecksum",
              compared.base_checksum AS "baseChecksum",
               compared.current_geometry_kind AS "currentGeometryKind",
               compared.base_geometry_kind AS "baseGeometryKind",
               compared.current_radius_m AS "currentRadiusM",
               compared.base_radius_m AS "baseRadiusM",
              CASE WHEN compared.current_geometry IS NULL THEN NULL
                   WHEN ST_NPoints(compared.current_geometry)<=500 THEN ST_AsGeoJSON(compared.current_geometry)::jsonb
                   ELSE ST_AsGeoJSON(ST_Envelope(compared.current_geometry))::jsonb END AS "currentGeometryPreview",
              CASE WHEN compared.base_geometry IS NULL THEN NULL
                   WHEN ST_NPoints(compared.base_geometry)<=500 THEN ST_AsGeoJSON(compared.base_geometry)::jsonb
                   ELSE ST_AsGeoJSON(ST_Envelope(compared.base_geometry))::jsonb END AS "baseGeometryPreview",
              CASE WHEN compared.current_geometry IS NULL THEN NULL
                   WHEN ST_NPoints(compared.current_geometry)<=500 THEN 'exact' ELSE 'bbox' END AS "currentPreviewMode",
              CASE WHEN compared.base_geometry IS NULL THEN NULL
                   WHEN ST_NPoints(compared.base_geometry)<=500 THEN 'exact' ELSE 'bbox' END AS "basePreviewMode",
              CASE WHEN compared.current_geometry IS NULL THEN NULL ELSE ARRAY[
                ST_XMin(compared.current_geometry),ST_YMin(compared.current_geometry),
                ST_XMax(compared.current_geometry),ST_YMax(compared.current_geometry)
              ] END AS "currentBounds",
              CASE WHEN compared.base_geometry IS NULL THEN NULL ELSE ARRAY[
                ST_XMin(compared.base_geometry),ST_YMin(compared.base_geometry),
                ST_XMax(compared.base_geometry),ST_YMax(compared.base_geometry)
              ] END AS "baseBounds",
               CASE WHEN compared.current_geometry IS NULL OR compared.base_geometry IS NULL THEN true
                    ELSE NOT ST_Equals(compared.current_geometry,compared.base_geometry)
                         OR compared.current_radius_m IS DISTINCT FROM compared.base_radius_m END AS "geometryChanged",
               current_public.value AS "currentPublicProperties",
               base_public.value AS "basePublicProperties"
       FROM compared
       LEFT JOIN LATERAL (
         SELECT COALESCE(jsonb_object_agg(field.key,compared.current_properties->field.key)
                  FILTER (WHERE compared.current_properties ? field.key),'{}'::jsonb) AS value
          FROM safe_fields field
       ) current_public ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(jsonb_object_agg(field.key,compared.base_properties->field.key)
                  FILTER (WHERE compared.base_properties ? field.key),'{}'::jsonb) AS value
          FROM safe_fields field
        ) base_public ON true
       WHERE (compared.current_id IS NULL OR compared.base_id IS NULL
              OR compared.current_checksum IS DISTINCT FROM compared.base_checksum)
         AND ($3::uuid IS NULL OR compared.feature_id>$3::uuid)
       ORDER BY compared.feature_id
       LIMIT $4`,
          [revisionId, identity.baseRevisionId, diffCursor?.featureId ?? null, query.limit + 1],
        )) as Array<Record<string, unknown> & { featureId: string }>;
        const hasMore = entryRows.length > query.limit;
        const entryPage = entryRows.slice(0, query.limit).map((row) => this.diffEntry(row));
        const lastEntry = entryRows.slice(0, query.limit).at(-1);
        return this.versioned({
          revisionId,
          layerId: identity.layerId,
          comparison: query.compareTo,
          baseRevisionId: identity.baseRevisionId,
          geometry: {
            currentFeatureCount: Number(feature.currentFeatureCount ?? 0),
            baseFeatureCount: Number(feature.baseFeatureCount ?? 0),
            added: Number(feature.added ?? 0),
            removed: Number(feature.removed ?? 0),
            modified: Number(feature.geometryModified ?? 0),
          },
          properties: {
            featuresModified: Number(feature.propertiesModified ?? 0),
            publicFieldKeysChanged: propertyKeys,
          },
          attachments: {
            available: false,
            status: 'unavailable',
            reasonCode: 'ATTACHMENT_CONTRACT_PENDING',
          },
          schema: {
            publicFieldsAdded: schema.added,
            publicFieldsRemoved: schema.removed,
            publicFieldsChanged: schema.changed,
            redactedChangeCount: Number(schema.redactedChangeCount),
          },
          entries: entryPage,
          nextCursor:
            hasMore && lastEntry
              ? this.encodeCursor({ featureId: String(lastEntry.featureId) })
              : null,
          hasMore,
          limit: query.limit,
        });
      });
    } catch (error) {
      const databaseError = error as {
        code?: string;
        driverError?: { code?: string };
      };
      if (databaseError?.code === '57014' || databaseError?.driverError?.code === '57014') {
        throw new AppException(
          422,
          'DIFF_TOO_LARGE',
          'Revision diff vượt giới hạn thời gian xử lý đồng bộ.',
          { reason: 'STATEMENT_TIMEOUT', statementTimeoutMs: 8_000 },
        );
      }
      throw error;
    }
  }

  async listPublicationHistory(layerId: string, query: PublicationHistoryQueryDto, actor: Actor) {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      await this.assertLayer(layerId, manager);
      const cursor = query.cursor ? this.decodeNumericCursor(query.cursor) : null;
      const rows = (await manager.query(
        `SELECT snapshot.id AS "snapshotId",snapshot.layer_id AS "layerId",
              snapshot.revision_id AS "revisionId",revision.revision_no AS "revisionNo",
              snapshot.status,snapshot.generation::integer AS generation,
              CASE WHEN snapshot.status='published' THEN 100 ELSE NULL END AS progress,
              snapshot.feature_count AS "featureCount",snapshot.bounds,snapshot.checksum,
              snapshot.manifest->>'rollbackOf' AS "rollbackOf",
              snapshot.published_by AS "publishedBy",publisher.display_name AS "publishedByDisplayName",
              snapshot.published_at AS "publishedAt",snapshot.activated_at AS "activatedAt",
              snapshot.created_at AS "createdAt",
              (pointer.active_snapshot_id=snapshot.id) AS "isActive",
              EXISTS(
                SELECT 1 FROM revision_participants participant
                WHERE participant.revision_id=snapshot.revision_id AND participant.user_id=$6
                  AND participant.participation_type=ANY('{edit,review}'::text[])
              ) AS "actorHasEditorialParticipation"
       FROM publication_snapshots snapshot
       JOIN layer_revisions revision ON revision.id=snapshot.revision_id
       LEFT JOIN users publisher ON publisher.id=snapshot.published_by
       LEFT JOIN layer_publications pointer ON pointer.layer_id=snapshot.layer_id
       WHERE snapshot.layer_id=$1
         AND ($2::text IS NULL OR snapshot.status=$2)
         AND ($3::bigint IS NULL OR snapshot.generation < $3)
         AND ($4::boolean=false OR snapshot.manifest ? 'rollbackOf')
       ORDER BY snapshot.generation DESC
       LIMIT $5`,
        [
          layerId,
          query.status ?? null,
          cursor?.value ?? null,
          query.rollbackOnly === 'true',
          query.limit + 1,
          actor.id,
        ],
      )) as Array<
        Record<string, unknown> & {
          generation: number;
          isActive: boolean;
          actorHasEditorialParticipation: boolean;
          activatedAt: Date | null;
          status: string;
        }
      >;
      const hasMore = rows.length > query.limit;
      const pageRows = rows.slice(0, query.limit);
      const items = pageRows.map((row) => {
        const eligible =
          actor.role === 'publisher' &&
          row.status === 'published' &&
          row.activatedAt !== null &&
          !row.isActive &&
          !row.actorHasEditorialParticipation;
        const reasonCode = eligible
          ? null
          : actor.role !== 'publisher'
            ? 'ROLE_FORBIDDEN'
            : row.isActive
              ? 'ROLLBACK_TARGET_ACTIVE'
              : row.actorHasEditorialParticipation
                ? 'SEPARATION_OF_DUTIES'
                : 'ROLLBACK_TARGET_INVALID';
        const safe: Record<string, unknown> = { ...row };
        delete safe.actorHasEditorialParticipation;
        return { ...safe, rollbackEligibility: { eligible, reasonCode } };
      });
      const last = pageRows.at(-1);
      const activePointerEtag = await this.publicationPointerEtag(layerId, manager);
      const page = {
        items,
        activePointerEtag,
        nextCursor: hasMore && last ? this.encodeCursor({ value: Number(last.generation) }) : null,
        hasMore,
        limit: query.limit,
      };
      return this.versioned(page);
    });
  }

  async getPublicationHistory(snapshotId: string, actor: Actor) {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const rows = (await manager.query(
        `SELECT snapshot.id AS "snapshotId",snapshot.layer_id AS "layerId",
              snapshot.revision_id AS "revisionId",revision.revision_no AS "revisionNo",
              snapshot.status,snapshot.generation::integer AS generation,
              CASE WHEN snapshot.status='published' THEN 100 ELSE NULL END AS progress,
              snapshot.feature_count AS "featureCount",snapshot.bounds,snapshot.checksum,
              snapshot.manifest->>'rollbackOf' AS "rollbackOf",
              snapshot.published_by AS "publishedBy",publisher.display_name AS "publishedByDisplayName",
              snapshot.published_at AS "publishedAt",snapshot.activated_at AS "activatedAt",
              snapshot.created_at AS "createdAt",
              (pointer.active_snapshot_id=snapshot.id) AS "isActive",
              EXISTS(
                SELECT 1 FROM revision_participants participant
                WHERE participant.revision_id=snapshot.revision_id AND participant.user_id=$2
                  AND participant.participation_type=ANY('{edit,review}'::text[])
              ) AS "actorHasEditorialParticipation"
       FROM publication_snapshots snapshot
       JOIN layer_revisions revision ON revision.id=snapshot.revision_id
       LEFT JOIN users publisher ON publisher.id=snapshot.published_by
       LEFT JOIN layer_publications pointer ON pointer.layer_id=snapshot.layer_id
       WHERE snapshot.id=$1`,
        [snapshotId, actor.id],
      )) as Array<
        Record<string, unknown> & {
          isActive: boolean;
          status: string;
          actorHasEditorialParticipation: boolean;
          activatedAt: Date | null;
        }
      >;
      const row = rows[0];
      if (!row) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy publication.');
      const eligible =
        actor.role === 'publisher' &&
        row.status === 'published' &&
        row.activatedAt !== null &&
        !row.isActive &&
        !row.actorHasEditorialParticipation;
      const reasonCode = eligible
        ? null
        : actor.role !== 'publisher'
          ? 'ROLE_FORBIDDEN'
          : row.isActive
            ? 'ROLLBACK_TARGET_ACTIVE'
            : row.actorHasEditorialParticipation
              ? 'SEPARATION_OF_DUTIES'
              : 'ROLLBACK_TARGET_INVALID';
      const safe: Record<string, unknown> = { ...row };
      delete safe.actorHasEditorialParticipation;
      const activePointerEtag = await this.publicationPointerEtag(String(row.layerId), manager);
      return this.versioned({
        publication: { ...safe, rollbackEligibility: { eligible, reasonCode } },
        activePointerEtag,
      });
    });
  }

  async listAuditHistory(query: AuditHistoryQueryDto, actor: Actor, layerId?: string) {
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Khoảng thời gian audit không hợp lệ.');
    }
    if (layerId) await this.assertLayer(layerId);
    const cursor = query.cursor ? this.decodeAuditCursor(query.cursor) : null;
    const values: unknown[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const where = ['TRUE'];
    if (layerId) {
      const scopeLayer = parameter(layerId);
      where.push(`scope.layer_id=${scopeLayer}::uuid`);
      if (actor.role !== 'system_admin') {
        const patterns = LAYER_AUDIT_ACTION_PATTERNS[actor.role] ?? [];
        const allowedPatterns = parameter(patterns);
        where.push(`audit.action LIKE ANY(${allowedPatterns}::text[])`);
      }
    }
    if (query.action) where.push(`audit.action=${parameter(query.action)}`);
    if (query.resourceType) where.push(`audit.resource_type=${parameter(query.resourceType)}`);
    if (query.resourceId) where.push(`audit.resource_id=${parameter(query.resourceId)}::uuid`);
    if (query.actorId) where.push(`audit.actor_id=${parameter(query.actorId)}::uuid`);
    if (query.requestId) where.push(`audit.request_id=${parameter(query.requestId)}::uuid`);
    if (query.from) where.push(`audit.occurred_at>=${parameter(query.from)}::timestamptz`);
    if (query.to) where.push(`audit.occurred_at<=${parameter(query.to)}::timestamptz`);
    if (cursor) {
      const occurredAt = parameter(cursor.occurredAt);
      const id = parameter(cursor.id);
      where.push(
        layerId
          ? `(scope.occurred_at,scope.audit_id)<(${occurredAt}::timestamptz,${id}::uuid)`
          : `(audit.occurred_at,audit.id)<(${occurredAt}::timestamptz,${id}::uuid)`,
      );
    }
    const limit = parameter(query.limit + 1);
    const rows = (await this.dataSource.query(
      `SELECT audit.id,audit.actor_id AS "actorId",audit.actor_role AS "actorRole",
              actor.display_name AS "actorDisplayName",audit.action,
              audit.resource_type AS "resourceType",audit.resource_id AS "resourceId",
              audit.request_id AS "requestId",audit.before_digest AS "beforeDigest",
              audit.after_digest AS "afterDigest",audit.metadata,audit.occurred_at AS "occurredAt"
       FROM audit_logs audit
       ${layerId ? 'JOIN audit_layer_scopes scope ON scope.audit_id=audit.id' : ''}
       LEFT JOIN users actor ON actor.id=audit.actor_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${layerId ? 'scope.occurred_at DESC,scope.audit_id DESC' : 'audit.occurred_at DESC,audit.id DESC'}
       LIMIT ${limit}`,
      values,
    )) as Array<Record<string, unknown> & { id: string; occurredAt: Date | string }>;
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) => ({
      ...row,
      metadata: this.sanitizeMetadata(
        row.metadata,
        String(row.action),
        String(row.resourceType),
        actor.role === 'system_admin',
      ),
    }));
    const last = items.at(-1);
    const page = {
      items,
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              occurredAt: new Date(last.occurredAt as string).toISOString(),
              id: String(last.id),
            })
          : null,
      hasMore,
      limit: query.limit,
    };
    return this.versioned(page);
  }

  async listWorkflowEvents(revisionId: string, query: WorkflowHistoryQueryDto) {
    const revisionRows = (await this.dataSource.query(`SELECT 1 FROM layer_revisions WHERE id=$1`, [
      revisionId,
    ])) as Array<Record<string, unknown>>;
    if (!revisionRows.length) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy revision.');
    const cursor = query.cursor ? this.decodeAuditCursor(query.cursor) : null;
    const rows = (await this.dataSource.query(
      `SELECT event.id,event.revision_id AS "revisionId",event.from_status AS "fromStatus",
              event.to_status AS "toStatus",event.actor_id AS "actorId",
              actor.display_name AS "actorDisplayName",actor.role,event.reason,
              event.occurred_at AS "occurredAt"
       FROM workflow_events event LEFT JOIN users actor ON actor.id=event.actor_id
       WHERE event.revision_id=$1
         AND ($2::timestamptz IS NULL OR (event.occurred_at,event.id)<($2::timestamptz,$3::uuid))
       ORDER BY event.occurred_at DESC,event.id DESC
       LIMIT $4`,
      [revisionId, cursor?.occurredAt ?? null, cursor?.id ?? null, query.limit + 1],
    )) as Array<Record<string, unknown> & { id: string; occurredAt: Date | string }>;
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return this.versioned({
      items,
      nextCursor:
        hasMore && last
          ? this.encodeCursor({
              occurredAt: new Date(last.occurredAt).toISOString(),
              id: last.id,
            })
          : null,
      hasMore,
      limit: query.limit,
    });
  }

  private diffEntry(row: Record<string, unknown>) {
    const beforeProperties = this.sanitizePublicProjection(row.basePublicProperties);
    const afterProperties = this.sanitizePublicProjection(row.currentPublicProperties);
    const propertyKeys = new Set([
      ...Object.keys(beforeProperties),
      ...Object.keys(afterProperties),
    ]);
    const changedPropertyKeys = [...propertyKeys]
      .filter(
        (key) => JSON.stringify(beforeProperties[key]) !== JSON.stringify(afterProperties[key]),
      )
      .sort();
    const changeType = row.currentId ? (row.baseId ? 'modified' : 'added') : 'removed';
    const hasVisibleChange = Boolean(row.geometryChanged) || changedPropertyKeys.length > 0;
    return {
      featureId: row.featureId,
      changeType,
      geometry: {
        changed: Boolean(row.geometryChanged),
        beforeKind: row.baseGeometryKind ?? null,
        afterKind: row.currentGeometryKind ?? null,
        beforeRadiusM: row.baseRadiusM == null ? null : Number(row.baseRadiusM),
        afterRadiusM: row.currentRadiusM == null ? null : Number(row.currentRadiusM),
        beforePreview: row.baseGeometryPreview ?? null,
        afterPreview: row.currentGeometryPreview ?? null,
        beforePreviewMode: row.basePreviewMode ?? null,
        afterPreviewMode: row.currentPreviewMode ?? null,
        beforeBounds: row.baseBounds ?? null,
        afterBounds: row.currentBounds ?? null,
      },
      properties: {
        before: beforeProperties,
        after: afterProperties,
        changedKeys: changedPropertyKeys,
      },
      attachments: {
        available: false,
        status: 'unavailable',
        reasonCode: 'ATTACHMENT_CONTRACT_PENDING',
      },
      redactedChange: changeType === 'modified' && !hasVisibleChange,
    };
  }

  private sanitizePublicProjection(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 100)
        .map(([key, item]) => [key, this.sanitizePublicValue(item)]),
    );
  }

  private sanitizePublicValue(value: unknown): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string')
      return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
    if (Array.isArray(value)) {
      return value
        .slice(0, 20)
        .map((item) =>
          item === null || ['string', 'number', 'boolean'].includes(typeof item)
            ? this.sanitizePublicValue(item)
            : '[OBJECT_REDACTED]',
        );
    }
    return '[OBJECT_REDACTED]';
  }

  private async assertLayer(
    layerId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    const rows = (await manager.query(`SELECT 1 FROM layers WHERE id=$1`, [layerId])) as Array<
      Record<string, unknown>
    >;
    if (!rows.length) throw new AppException(404, 'NOT_FOUND', 'Không tìm thấy layer.');
  }

  private async publicationPointerEtag(
    layerId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<string | null> {
    const rows = (await manager.query(
      `SELECT pointer.active_snapshot_id AS "activeSnapshotId",
              snapshot.generation::integer AS generation
       FROM layer_publications pointer
       JOIN publication_snapshots snapshot ON snapshot.id=pointer.active_snapshot_id
       WHERE pointer.layer_id=$1`,
      [layerId],
    )) as Array<{ activeSnapshotId: string; generation: number }>;
    const pointer = rows[0];
    return pointer
      ? publicationPointerEtag(layerId, pointer.activeSnapshotId, Number(pointer.generation))
      : null;
  }

  private numericPage<T>(rows: T[], limit: number, cursorValue: (row: T) => number) {
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? this.encodeCursor({ value: cursorValue(last) }) : null,
      hasMore,
      limit,
    };
  }

  private versioned<T>(data: T): { data: T; etag: string } {
    return { data, etag: `"history-${this.crypto.checksum(JSON.stringify(data))}"` };
  }

  private encodeCursor(value: NumericPageCursor | AuditPageCursor | FeatureDiffCursor): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  private decodeNumericCursor(value: string): NumericPageCursor {
    const cursor = this.decodeCursor(value) as Partial<NumericPageCursor>;
    if (!Number.isSafeInteger(cursor.value) || Number(cursor.value) < 1) this.invalidCursor();
    return { value: Number(cursor.value) };
  }

  private decodeAuditCursor(value: string): AuditPageCursor {
    const cursor = this.decodeCursor(value) as Partial<AuditPageCursor>;
    if (
      typeof cursor.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(cursor.occurredAt)) ||
      typeof cursor.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.id)
    ) {
      this.invalidCursor();
    }
    return { occurredAt: cursor.occurredAt, id: cursor.id } as AuditPageCursor;
  }

  private decodeFeatureDiffCursor(value: string): FeatureDiffCursor {
    const cursor = this.decodeCursor(value) as Partial<FeatureDiffCursor>;
    if (
      typeof cursor.featureId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        cursor.featureId,
      )
    ) {
      this.invalidCursor();
    }
    return { featureId: cursor.featureId } as FeatureDiffCursor;
  }

  private decodeCursor(value: string): unknown {
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      if (!decoded || Buffer.from(decoded, 'utf8').toString('base64url') !== value) {
        this.invalidCursor();
      }
      return JSON.parse(decoded) as unknown;
    } catch (error) {
      if (error instanceof AppException) throw error;
      this.invalidCursor();
    }
  }

  private invalidCursor(): never {
    throw new AppException(400, 'VALIDATION_FAILED', 'Cursor không hợp lệ.');
  }

  private sanitizeMetadata(
    value: unknown,
    action: string,
    resourceType: string,
    systemAdmin: boolean,
    depth = 0,
    parentKey = '',
  ): unknown {
    if (
      /password|secret|token|encrypted|recovery|csrf|credential|cookie|totp|authorization/i.test(
        parentKey,
      )
    ) {
      return '[REDACTED]';
    }
    if (depth >= 4) return '[TRUNCATED]';
    if (Array.isArray(value)) {
      const items = value
        .slice(0, 20)
        .map((item) => this.sanitizeMetadata(item, action, resourceType, systemAdmin, depth + 1));
      if (value.length > 20) items.push(`[${value.length - 20} MORE]`);
      return items;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const allowlist =
        depth === 0
          ? new Set(AUDIT_ACTION_METADATA_KEYS[action] ?? [])
          : systemAdmin
            ? SYSTEM_AUDIT_METADATA_KEYS
            : CONTENT_AUDIT_METADATA_KEYS;
      if (depth === 0 && !systemAdmin && !CONTENT_RESOURCE_TYPES.includes(resourceType)) return {};
      const allowedEntries = entries.filter(([key]) => allowlist.has(key));
      const safe = Object.fromEntries(
        allowedEntries
          .slice(0, 50)
          .map(([key, item]) => [
            key,
            this.sanitizeMetadata(item, action, resourceType, systemAdmin, depth + 1, key),
          ]),
      );
      if (allowedEntries.length > 50) safe._truncatedKeyCount = allowedEntries.length - 50;
      return safe;
    }
    if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
    return value;
  }
}
