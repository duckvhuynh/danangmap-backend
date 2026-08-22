import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import { canonicalPublicFieldSql } from '../common/public-field.policy';
import { GeoServiceAdapter, type GeoBias } from './geo-service.adapter';

interface PublishedLayerRow {
  id: string;
  slug: string;
  displayOrder: number;
  defaultVisible: boolean;
  groupId: string | null;
  groupSlug: string | null;
  groupTitle: string | null;
  groupDisplayOrder: number | null;
  title: string;
  description: string | null;
  geometryMode: string;
  allowedGeometryKinds: string[];
  snapshotId: string;
  revisionId: string;
  generation: string;
  featureCount: number;
  bounds: number[] | null;
  style: Record<string, unknown>;
  renderConfig: Record<string, unknown>;
  popupConfig: Record<string, unknown>;
  manifest: Record<string, unknown>;
  filterFields: string[] | null;
  searchFields: string[] | null;
  publicFields: string[] | null;
  updatedAt: Date;
}

interface PublicFeatureRow {
  id: string;
  versionId: string;
  geometry: Record<string, unknown>;
  properties: Record<string, unknown>;
  geometryKind: string;
  radiusM: number | null;
}

@Injectable()
export class PublicApiService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly geoService: GeoServiceAdapter,
  ) {}

  async catalog() {
    const rows = await this.publishedLayers();
    const data = rows.map((row) => this.catalogItem(row));
    return { data, etag: this.etag(data) };
  }

  async layerDetail(slug: string) {
    const row = await this.publishedLayer(slug);
    const fields = (await this.dataSource.query(
      `SELECT id,key,label,description,type,icon,required,searchable,filterable,sortable,
              default_value AS "defaultValue",validation,options,display_order AS "displayOrder"
       FROM layer_fields field
       WHERE revision_id=$1 AND ${canonicalPublicFieldSql('field')}
       ORDER BY display_order,id`,
      [row.revisionId],
    )) as Record<string, unknown>[];
    const data = { ...this.catalogItem(row), fields };
    return { data, etag: this.etag(data) };
  }

  async featureCollection(slug: string, bboxValue?: string, limitValue = 1000, filter?: string) {
    const layer = await this.publishedLayer(slug);
    if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 5000) {
      throw new AppException(400, 'INVALID_LIMIT', 'limit phải từ 1 đến 5.000.');
    }
    const limit = Math.min(Math.max(limitValue, 1), 5000);
    const bbox = bboxValue ? this.parseBbox(bboxValue) : null;
    const parameters: unknown[] = [layer.revisionId, limit + 1];
    const predicates = ['rf.revision_id=$1', 'f.deleted_at IS NULL'];
    if (bbox) {
      parameters.push(...bbox);
      predicates.push(
        `fv.geometry && ST_MakeEnvelope($3,$4,$5,$6,4326)`,
        `ST_Intersects(fv.geometry,ST_MakeEnvelope($3,$4,$5,$6,4326))`,
      );
    }
    if (filter) {
      const parsed = this.parseFilter(filter);
      const field = (await this.dataSource.query(
        `SELECT 1 FROM layer_fields field
         WHERE revision_id=$1 AND key=$2 AND ${canonicalPublicFieldSql('field')}
           AND filterable=true`,
        [layer.revisionId, parsed.key],
      )) as unknown[];
      if (!field.length)
        throw new AppException(400, 'FILTER_NOT_ALLOWED', 'Trường lọc không hợp lệ.');
      parameters.push(parsed.key, parsed.value);
      const keyIndex = parameters.length - 1;
      predicates.push(`fv.properties ->> $${keyIndex} = $${keyIndex + 1}`);
    }
    const rows = (await this.dataSource.query(
      `SELECT f.id, fv.id AS "versionId", ST_AsGeoJSON(fv.geometry)::jsonb AS geometry,
              fv.geometry_kind AS "geometryKind",fv.radius_m AS "radiusM",
              COALESCE((SELECT jsonb_object_agg(entry.key,entry.value)
                FROM jsonb_each(fv.properties) entry
                JOIN layer_fields lf ON lf.revision_id=$1 AND lf.key=entry.key
                  AND ${canonicalPublicFieldSql('lf')}),'{}'::jsonb) AS properties
       FROM revision_features rf
       JOIN features f ON f.id=rf.feature_id
       JOIN feature_versions fv ON fv.id=rf.feature_version_id
       WHERE ${predicates.join(' AND ')} ORDER BY rf.ordinal,f.id LIMIT $2`,
      parameters,
    )) as PublicFeatureRow[];
    const truncated = rows.length > limit;
    const selected = rows.slice(0, limit);
    const collection = {
      type: 'FeatureCollection' as const,
      features: selected.map((row) => ({
        type: 'Feature' as const,
        id: row.id,
        geometry: row.geometry,
        properties: row.properties,
        geometryKind: row.geometryKind,
        radiusM: row.radiusM,
      })),
      meta: {
        layerSlug: slug,
        generation: Number(layer.generation),
        returned: selected.length,
        truncated,
        nextCursor: null,
      },
    };
    if (Buffer.byteLength(JSON.stringify(collection), 'utf8') > 10 * 1024 * 1024) {
      throw new AppException(
        400,
        'QUERY_TOO_BROAD',
        'Kết quả vượt quá 10 MiB; hãy thu nhỏ bbox hoặc dùng MVT.',
      );
    }
    return { data: collection, etag: this.etag(collection) };
  }

  async feature(slug: string, featureId: string) {
    const layer = await this.publishedLayer(slug);
    const rows = (await this.dataSource.query(
      `SELECT f.id, fv.id AS "versionId", ST_AsGeoJSON(fv.geometry)::jsonb AS geometry,
              fv.geometry_kind AS "geometryKind",fv.radius_m AS "radiusM",
              COALESCE((SELECT jsonb_object_agg(entry.key,entry.value)
                FROM jsonb_each(fv.properties) entry
                JOIN layer_fields lf ON lf.revision_id=$1 AND lf.key=entry.key
                  AND ${canonicalPublicFieldSql('lf')}),'{}'::jsonb) AS properties
       FROM revision_features rf
       JOIN features f ON f.id=rf.feature_id AND f.deleted_at IS NULL
       JOIN feature_versions fv ON fv.id=rf.feature_version_id
       WHERE rf.revision_id=$1 AND f.id=$2`,
      [layer.revisionId, featureId],
    )) as PublicFeatureRow[];
    const row = rows[0];
    if (!row) throw new AppException(404, 'FEATURE_NOT_FOUND', 'Không tìm thấy đối tượng.');
    const data = {
      type: 'Feature',
      id: row.id,
      geometry: row.geometry,
      properties: row.properties,
      attachments: [],
      meta: {
        layerSlug: slug,
        snapshotId: layer.snapshotId,
        generation: Number(layer.generation),
        geometryKind: row.geometryKind,
        radiusM: row.radiusM,
      },
    };
    return { data, etag: `"feature-${layer.snapshotId}-${row.versionId}"` };
  }

  async tile(slug: string, generationValue: number, z: number, x: number, y: number) {
    if (z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      throw new AppException(400, 'INVALID_TILE', 'Tọa độ tile không hợp lệ.');
    }
    const snapshot = (await this.dataSource.query(
      `SELECT s.id,s.revision_id AS "revisionId"
       FROM publication_snapshots s JOIN layers l ON l.id=s.layer_id
       WHERE l.slug=$1 AND s.generation=$2 AND s.status='published' AND l.archived_at IS NULL`,
      [slug, generationValue],
    )) as Array<{ id: string; revisionId: string }>;
    if (!snapshot[0]) throw new AppException(404, 'TILESET_NOT_FOUND', 'Không tìm thấy tileset.');
    const result = (await this.dataSource.query(
      `WITH bounds AS (SELECT ST_TileEnvelope($2,$3,$4) AS geom), tile_rows AS (
         SELECT f.id::text AS feature_id,fv.geometry_kind,fv.radius_m,
           COALESCE((SELECT jsonb_object_agg(entry.key,entry.value)
             FROM jsonb_each(fv.properties) entry
             JOIN layer_fields lf ON lf.revision_id=$1 AND lf.key=entry.key
               AND ${canonicalPublicFieldSql('lf')}),'{}'::jsonb) AS properties,
           ST_AsMVTGeom(ST_Transform(rendered.geometry,3857),bounds.geom,4096,64,true) AS geom
         FROM bounds,revision_features rf
         JOIN features f ON f.id=rf.feature_id AND f.deleted_at IS NULL
         JOIN feature_versions fv ON fv.id=rf.feature_version_id
         CROSS JOIN LATERAL (
           SELECT CASE WHEN fv.geometry_kind='circle'
             THEN ST_Buffer(fv.geometry::geography,fv.radius_m)::geometry
             ELSE fv.geometry
           END AS geometry
         ) rendered
         WHERE rf.revision_id=$1
           AND rendered.geometry && ST_Transform(bounds.geom,4326)
           AND ST_Intersects(ST_Transform(rendered.geometry,3857),bounds.geom)
       ) SELECT ST_AsMVT(tile_rows,'features',4096,'geom') AS tile FROM tile_rows`,
      [snapshot[0].revisionId, z, x, y],
    )) as Array<{ tile: Buffer | null }>;
    return {
      tile: result[0]?.tile ?? Buffer.alloc(0),
      etag: `"tile-${snapshot[0].id}-${generationValue}-${z}-${x}-${y}"`,
    };
  }

  async search(input: {
    q: string;
    sources?: string;
    layerIds?: string;
    center?: string;
    radiusM?: number;
    limit?: number;
  }) {
    const q = input.q.trim();
    if (q.length < 2 || q.length > 200)
      throw new AppException(400, 'INVALID_QUERY', 'Từ khóa phải dài từ 2 đến 200 ký tự.');
    const sources = new Set((input.sources ?? 'internal,place').split(','));
    if ([...sources].some((source) => !['internal', 'place'].includes(source))) {
      throw new AppException(400, 'INVALID_SOURCE', 'Nguồn tìm kiếm không hợp lệ.');
    }
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 30)
    ) {
      throw new AppException(400, 'INVALID_LIMIT', 'limit phải từ 1 đến 30.');
    }
    if (input.radiusM !== undefined && !Number.isInteger(input.radiusM)) {
      throw new AppException(400, 'INVALID_RADIUS', 'radiusM phải là số nguyên.');
    }
    const limit = input.limit ?? 10;
    const internal = sources.has('internal')
      ? await this.internalSearch(q, input.layerIds, limit)
      : [];
    const bias = this.parseBias(input.center, input.radiusM);
    let external: Awaited<ReturnType<GeoServiceAdapter['textSearch']>> = [];
    let geoStatus: 'ok' | 'skipped' | 'unavailable' = sources.has('place') ? 'ok' : 'skipped';
    if (sources.has('place')) {
      try {
        external = await this.geoService.textSearch(q, bias);
      } catch {
        geoStatus = 'unavailable';
      }
    }
    const externalResults = external.map((place) => ({
      id: `place:${place.id}`,
      source: 'geo_service',
      kind: 'place',
      title: place.title,
      subtitle: place.subtitle,
      position: place.position,
      bbox: null,
      layer: null,
      featureId: null,
      providerPlaceId: place.id,
      score: place.score,
      highlights: [],
    }));
    const data = [...internal, ...externalResults]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return {
      data,
      meta: {
        partial: geoStatus === 'unavailable',
        sources: {
          internal: { status: sources.has('internal') ? 'ok' : 'skipped', count: internal.length },
          geoService: { status: geoStatus, count: externalResults.length },
        },
        warnings:
          geoStatus === 'unavailable'
            ? [
                {
                  code: 'GEO_SERVICE_UNAVAILABLE',
                  message: 'Kết quả địa điểm bên ngoài tạm thời chưa khả dụng.',
                },
              ]
            : [],
        nextCursor: null,
      },
    };
  }

  async placeDetails(placeId: string, fieldsValue?: string) {
    const allowed = new Set(['name', 'address', 'position', 'phone', 'website']);
    const fields = (fieldsValue ?? 'name,address,position').split(',');
    if (fields.some((field) => !allowed.has(field)))
      throw new AppException(400, 'INVALID_FIELDS', 'Danh sách field không hợp lệ.');
    try {
      return { ...(await this.geoService.placeDetails(placeId, fields)), source: 'geo_service' };
    } catch {
      throw new AppException(
        503,
        'GEO_SERVICE_UNAVAILABLE',
        'Dịch vụ địa điểm tạm thời chưa khả dụng.',
      );
    }
  }

  private async internalSearch(q: string, layerIdsValue: string | undefined, limit: number) {
    const layerIds = layerIdsValue ? layerIdsValue.split(',') : [];
    if (layerIds.length > 20)
      throw new AppException(400, 'TOO_MANY_LAYERS', 'Chỉ được tìm tối đa 20 lớp.');
    if (
      layerIds.some(
        (id) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
      )
    ) {
      throw new AppException(400, 'INVALID_LAYER_ID', 'layerIds phải là UUID hợp lệ.');
    }
    return (await this.dataSource.query(
      `WITH candidates AS (
         SELECT f.id AS "featureId",l.id AS "layerId",l.slug,r.title AS "layerTitle",
           COALESCE(title_property.value,f.id::text) AS title,
           COALESCE(subtitle_property.value,'') AS subtitle,
           ST_PointOnSurface(fv.geometry) AS focus,
           similarity(
             unaccent(lower(COALESCE(title_property.value,''))),
             unaccent(lower($1))
           ) AS score
         FROM layer_publications lp
         JOIN publication_snapshots s ON s.id=lp.active_snapshot_id AND s.status='published'
         JOIN layers l ON l.id=lp.layer_id AND l.archived_at IS NULL
         JOIN layer_revisions r ON r.id=s.revision_id
         JOIN revision_features rf ON rf.revision_id=r.id
         JOIN features f ON f.id=rf.feature_id AND f.deleted_at IS NULL
         JOIN feature_versions fv ON fv.id=rf.feature_version_id
         LEFT JOIN LATERAL (
           SELECT property.value
           FROM jsonb_each_text(fv.properties) property
           JOIN layer_fields field ON field.revision_id=r.id AND field.key=property.key
             AND ${canonicalPublicFieldSql('field')}
           WHERE property.key=ANY('{name,title}'::text[])
           ORDER BY CASE property.key WHEN 'name' THEN 0 ELSE 1 END
           LIMIT 1
         ) title_property ON true
         LEFT JOIN LATERAL (
           SELECT property.value
           FROM jsonb_each_text(fv.properties) property
           JOIN layer_fields field ON field.revision_id=r.id AND field.key=property.key
             AND ${canonicalPublicFieldSql('field')}
           WHERE property.key='address'
           LIMIT 1
         ) subtitle_property ON true
         WHERE ($3::uuid[] IS NULL OR l.id=ANY($3::uuid[]))
           AND EXISTS (SELECT 1 FROM layer_fields field, jsonb_each_text(fv.properties) prop
             WHERE field.revision_id=r.id AND field.key=prop.key
               AND ${canonicalPublicFieldSql('field')} AND field.searchable=true
               AND unaccent(prop.value) ILIKE '%'||unaccent($1)||'%')
       ) SELECT 'feature:'||"featureId" AS id,'internal' AS source,'feature' AS kind,title,
           NULLIF(subtitle,'') AS subtitle,
           jsonb_build_object('longitude',ST_X(focus),'latitude',ST_Y(focus)) AS position,
           NULL::jsonb AS bbox,
           jsonb_build_object('id',"layerId",'slug',slug,'title',"layerTitle") AS layer,
           "featureId",NULL::text AS "providerPlaceId",GREATEST(score,0.1) AS score,
           ARRAY[]::text[] AS highlights
         FROM candidates ORDER BY score DESC,title LIMIT $2`,
      [q, limit, layerIds.length ? layerIds : null],
    )) as Array<Record<string, unknown> & { score: number }>;
  }

  private async publishedLayers(): Promise<PublishedLayerRow[]> {
    return (await this.dataSource.query(
      `SELECT l.id,l.slug,l.display_order AS "displayOrder",l.default_visible AS "defaultVisible",
          g.id AS "groupId",g.slug AS "groupSlug",
          g.title AS "groupTitle",g.display_order AS "groupDisplayOrder",r.title,r.description,
          r.geometry_mode AS "geometryMode",r.allowed_geometry_kinds AS "allowedGeometryKinds",
          r.style,r.render_config AS "renderConfig",r.popup_config AS "popupConfig",
          s.id AS "snapshotId",s.revision_id AS "revisionId",s.generation,s.feature_count AS "featureCount",
          s.bounds,s.manifest,lp.pointer_updated_at AS "updatedAt",
          ARRAY(SELECT field.key FROM layer_fields field
            WHERE field.revision_id=r.id AND ${canonicalPublicFieldSql('field')}
              AND field.filterable=true ORDER BY field.display_order,field.id) AS "filterFields",
          ARRAY(SELECT field.key FROM layer_fields field
            WHERE field.revision_id=r.id AND ${canonicalPublicFieldSql('field')}
              AND field.searchable=true ORDER BY field.display_order,field.id) AS "searchFields",
          ARRAY(SELECT field.key FROM layer_fields field
            WHERE field.revision_id=r.id AND ${canonicalPublicFieldSql('field')}
            ORDER BY field.display_order,field.id) AS "publicFields"
       FROM layer_publications lp
       JOIN layers l ON l.id=lp.layer_id AND l.archived_at IS NULL
       LEFT JOIN layer_groups g ON g.id=l.group_id AND g.archived_at IS NULL
       JOIN publication_snapshots s ON s.id=lp.active_snapshot_id AND s.status='published'
       JOIN layer_revisions r ON r.id=s.revision_id
       ORDER BY g.display_order NULLS LAST,l.display_order,l.id`,
    )) as PublishedLayerRow[];
  }

  private async publishedLayer(slug: string): Promise<PublishedLayerRow> {
    const row = (await this.publishedLayers()).find((candidate) => candidate.slug === slug);
    if (!row) throw new AppException(404, 'LAYER_NOT_FOUND', 'Không tìm thấy lớp dữ liệu.');
    return row;
  }

  private catalogItem(row: PublishedLayerRow) {
    const configuredSourceKind = this.stringConfig(
      row.manifest.sourceKind ?? row.renderConfig.sourcePolicy,
      'geojson',
    );
    const sourceKind = row.featureCount > 1000 ? 'mvt' : configuredSourceKind;
    const generation = Number(row.generation);
    return {
      id: row.id,
      slug: row.slug,
      group: row.groupId
        ? {
            id: row.groupId,
            slug: row.groupSlug,
            title: row.groupTitle,
            displayOrder: row.groupDisplayOrder,
          }
        : null,
      displayOrder: row.displayOrder,
      defaultVisible: row.defaultVisible,
      title: row.title,
      description: row.description,
      geometryMode: row.geometryMode,
      allowedGeometryKinds: row.allowedGeometryKinds,
      snapshotId: row.snapshotId,
      revisionId: row.revisionId,
      generation,
      featureCount: row.featureCount,
      bounds: row.bounds,
      sourceKind,
      geoJsonUrl: `/api/v1/public/layers/${row.slug}/features`,
      tileUrlTemplate: `/api/v1/public/tiles/${row.slug}/${generation}/{z}/{x}/{y}.pbf`,
      sourceLayer: this.stringConfig(row.manifest.sourceLayer, 'features'),
      minZoom: Number(row.renderConfig.minZoom ?? 0),
      maxZoom: Number(row.renderConfig.maxZoom ?? 18),
      cluster: Boolean(row.renderConfig.cluster),
      style: row.style,
      popupConfig: this.publicPopupConfig(row.popupConfig, row.publicFields ?? []),
      filterCapabilities: { fieldKeys: row.filterFields ?? [], maxFilters: 10 },
      searchCapabilities: {
        enabled: Boolean(row.searchFields?.length),
        fieldKeys: row.searchFields ?? [],
      },
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private publicPopupConfig(
    popupConfig: Record<string, unknown>,
    publicFields: string[],
  ): Record<string, unknown> {
    const allowed = new Set(publicFields);
    const result: Record<string, unknown> = {};
    if (typeof popupConfig.titleField === 'string' && allowed.has(popupConfig.titleField)) {
      result.titleField = popupConfig.titleField;
    }
    if (typeof popupConfig.subtitleField === 'string' && allowed.has(popupConfig.subtitleField)) {
      result.subtitleField = popupConfig.subtitleField;
    }
    if (Array.isArray(popupConfig.fieldKeys)) {
      result.fieldKeys = popupConfig.fieldKeys.filter(
        (key): key is string => typeof key === 'string' && allowed.has(key),
      );
    }
    if (typeof popupConfig.showCoordinates === 'boolean') {
      result.showCoordinates = popupConfig.showCoordinates;
    }
    return result;
  }

  private parseBbox(value: string): [number, number, number, number] {
    const values = value.split(',').map(Number);
    if (values.length !== 4 || values.some((number) => !Number.isFinite(number))) {
      throw new AppException(400, 'INVALID_BBOX', 'Bbox không hợp lệ.');
    }
    const west = values[0]!;
    const south = values[1]!;
    const east = values[2]!;
    const north = values[3]!;
    if (west >= east || south >= north || west < -180 || east > 180 || south < -90 || north > 90) {
      throw new AppException(400, 'INVALID_BBOX', 'Bbox không hợp lệ.');
    }
    if ((east - west) * (north - south) > 25) {
      throw new AppException(
        400,
        'QUERY_TOO_BROAD',
        'Bbox quá rộng; hãy thu nhỏ vùng xem hoặc dùng MVT.',
      );
    }
    return [west, south, east, north];
  }

  private parseFilter(filter: string) {
    const match = /^([a-z][a-z0-9_]{1,63}):eq:(.{1,500})$/.exec(filter);
    if (!match) throw new AppException(400, 'INVALID_FILTER', 'Bộ lọc không hợp lệ.');
    return { key: match[1], value: match[2] };
  }

  private parseBias(center?: string, radiusM?: number): GeoBias | undefined {
    if (!center) {
      if (radiusM !== undefined)
        throw new AppException(400, 'CENTER_REQUIRED', 'radiusM yêu cầu center.');
      return undefined;
    }
    const values = center.split(',').map(Number);
    const latitude = values[0]!;
    const longitude = values[1]!;
    if (values.length !== 2 || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new AppException(400, 'INVALID_CENTER', 'center không hợp lệ.');
    }
    if (radiusM !== undefined && (radiusM < 1 || radiusM > 50_000)) {
      throw new AppException(400, 'INVALID_RADIUS', 'radiusM phải từ 1 đến 50.000 mét.');
    }
    return { latitude, longitude, radiusM };
  }

  private etag(value: unknown): string {
    return `"${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}"`;
  }

  private stringConfig(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
  }
}
