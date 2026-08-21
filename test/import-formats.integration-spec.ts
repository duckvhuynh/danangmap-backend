import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import { Client } from 'minio';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import type { ImportFormat } from '../src/domain/enums';
import type { ImportFileInspector } from '../src/imports/import-file.inspector';
import { ImportJobEntity } from '../src/imports/import.entity';
import type { UpdateImportMappingDto } from '../src/imports/import.dto';
import { ImportsService } from '../src/imports/imports.service';
import { IMPORT_QUEUE } from '../src/jobs/jobs.constants';
import { LayerFieldEntity, LayerRevisionEntity } from '../src/layers/layer.entities';
import type { StorageService } from '../src/storage/storage.service';

interface Fixture {
  name: string;
  format: ImportFormat;
  content: Buffer;
  mapping: UpdateImportMappingDto;
}

describe('Four-format import equivalence', () => {
  const editorId = '00000000-0000-4000-8000-000000000002';
  const minio = new Client({
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'danangmap',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'danangmap-local-secret',
  });
  const queue = new Queue(IMPORT_QUEUE, {
    connection: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null,
    },
    prefix: 'danangmap:q',
  });
  const actor = {
    id: editorId,
    role: 'editor',
    sessionId: randomUUID(),
    displayName: 'Four-format editor',
  };
  const resourceIds: string[] = [];
  const objectKeys: string[] = [];
  const reportKeys: string[] = [];
  const receiptKeys: string[] = [];
  let imports: ImportsService;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    imports = new ImportsService(
      AppDataSource.getRepository(ImportJobEntity),
      AppDataSource.getRepository(LayerRevisionEntity),
      AppDataSource.getRepository(LayerFieldEntity),
      queue,
      AppDataSource,
      {} as StorageService,
      {} as ImportFileInspector,
      new IdempotencyService(),
    );
  });

  afterAll(async () => {
    await Promise.all(
      [...objectKeys, ...reportKeys].map((key) =>
        minio.removeObject('danangmap', key).catch(() => undefined),
      ),
    );
    for (const importId of resourceIds.filter((_, index) => index % 3 === 2)) {
      for (const prefix of ['validate', 'apply']) {
        const jobs = await queue.getJobs(['completed', 'failed', 'waiting', 'delayed']);
        await Promise.all(
          jobs
            .filter((job) => job.id?.startsWith(`${prefix}-${importId}`))
            .map((job) => job.remove().catch(() => undefined)),
        );
      }
    }
    await queue.close();
    if (AppDataSource.isInitialized && resourceIds.length) {
      const layerIds = resourceIds.filter((_, index) => index % 3 === 0);
      const revisionIds = resourceIds.filter((_, index) => index % 3 === 1);
      const importIds = resourceIds.filter((_, index) => index % 3 === 2);
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
        await manager.query(
          `DELETE FROM command_receipts
           WHERE actor_id=$1 AND operation='import.apply' AND idempotency_key=ANY($2::uuid[])`,
          [editorId, receiptKeys],
        );
        await manager.query('DELETE FROM import_jobs WHERE id=ANY($1::uuid[])', [importIds]);
        await manager.query('DELETE FROM revision_changes WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM revision_features WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM feature_versions WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM features WHERE layer_id=ANY($1::uuid[])', [layerIds]);
        await manager.query('DELETE FROM audit_logs WHERE resource_id=ANY($1::uuid[])', [
          importIds,
        ]);
        await manager.query('DELETE FROM layer_revisions WHERE id=ANY($1::uuid[])', [revisionIds]);
        await manager.query('DELETE FROM layers WHERE id=ANY($1::uuid[])', [layerIds]);
        await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
      });
      await AppDataSource.destroy();
    }
  });

  it('produces the same two valid EPSG:4326 features and one row issue for every parser', async () => {
    const fixtures = await buildFixtures();
    const normalizedOutputs: unknown[] = [];
    for (const fixture of fixtures) {
      const layerId = randomUUID();
      const revisionId = randomUUID();
      const importId = randomUUID();
      resourceIds.push(layerId, revisionId, importId);
      const objectKey = `quarantine/imports/test/${importId}/${fixture.name}`;
      const reportKey = `reports/imports/${importId}/validation.json`;
      objectKeys.push(objectKey);
      reportKeys.push(reportKey);
      await minio.putObject('danangmap', objectKey, fixture.content, fixture.content.byteLength, {
        'Content-Type': 'application/octet-stream',
      });
      await createDraft(layerId, revisionId, fixture.name);
      await AppDataSource.query(
        `INSERT INTO import_jobs(
           id,revision_id,actor_id,object_key,file_name,size_bytes,format,mode,status,progress,
           mapping,counts,idempotency_key
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'append','mapping_required',100,'{}','{}',$8)`,
        [
          importId,
          revisionId,
          editorId,
          objectKey,
          fixture.name,
          fixture.content.byteLength,
          fixture.format,
          randomUUID(),
        ],
      );
      await imports.updateMapping(importId, fixture.mapping, actor);
      await imports.validate(importId, actor);
      const ready = await waitForImport(importId, 'ready');
      expect(ready.counts).toMatchObject({ total: 3, valid: 2, invalid: 1, new: 2 });
      const issues = await imports.issues(importId, undefined, '100', actor);
      expect(issues.data).toEqual([
        expect.objectContaining({ rowNumber: 3, severity: 'error', code: 'SCHEMA_VIOLATION' }),
      ]);

      await expect(
        imports.apply(
          importId,
          { skipInvalid: false, acknowledgedWarningCodes: [] },
          `"rev-${revisionId}-v1"`,
          randomUUID(),
          randomUUID(),
          actor,
        ),
      ).rejects.toMatchObject({ code: 'IMPORT_HAS_ERRORS' });
      expect(await revisionDelta(revisionId)).toEqual({ lockVersion: 1, featureCount: 0 });

      const applyKey = randomUUID();
      receiptKeys.push(applyKey);
      await imports.apply(
        importId,
        { skipInvalid: true, acknowledgedWarningCodes: [] },
        `"rev-${revisionId}-v1"`,
        applyKey,
        randomUUID(),
        actor,
      );
      const completed = await waitForImport(importId, 'completed');
      expect(completed.counts).toMatchObject({ applied: 2, skipped: 1 });
      expect(await revisionDelta(revisionId)).toEqual({ lockVersion: 2, featureCount: 2 });
      const beforeReplay = await normalizedFeatures(revisionId);
      await imports.apply(
        importId,
        { skipInvalid: true, acknowledgedWarningCodes: [] },
        `"rev-${revisionId}-v1"`,
        applyKey,
        randomUUID(),
        actor,
      );
      expect(await normalizedFeatures(revisionId)).toEqual(beforeReplay);
      expect(await revisionDelta(revisionId)).toEqual({ lockVersion: 2, featureCount: 2 });
      normalizedOutputs.push(beforeReplay);
    }
    expect(normalizedOutputs).toHaveLength(5);
    normalizedOutputs.slice(1).forEach((output) => expect(output).toEqual(normalizedOutputs[0]));
  });

  it('upserts by feature_id without trusting unmatched client UUIDs or crossing layers', async () => {
    const layerId = randomUUID();
    const revisionId = randomUUID();
    const importId = randomUUID();
    const targetFeatureId = randomUUID();
    const targetVersionId = randomUUID();
    const preservedFeatureId = randomUUID();
    const preservedVersionId = randomUUID();
    const unmatchedClientId = randomUUID();
    resourceIds.push(layerId, revisionId, importId);
    const foreignRows = (await AppDataSource.query(
      `SELECT id FROM features WHERE layer_id<>$1 AND deleted_at IS NULL LIMIT 1`,
      [layerId],
    )) as Array<{ id: string }>;
    const foreignFeatureId = foreignRows[0]?.id;
    if (!foreignFeatureId) throw new Error('Seeded foreign feature is required');
    const payload = Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          geoJsonPoint(targetFeatureId, 'Đã cập nhật', 'new-source', 'new-id', 108.2, 16.05),
          geoJsonPoint(preservedFeatureId, 'Giữ định danh', null, null, 108.205, 16.055),
          geoJsonPoint(unmatchedClientId, 'Đối tượng mới', null, null, 108.21, 16.06),
          geoJsonPoint('not-a-uuid', 'Sai UUID', null, null, 108.22, 16.07),
          geoJsonPoint(foreignFeatureId, 'Sai layer', null, null, 108.23, 16.08),
        ],
      }),
    );
    const objectKey = `quarantine/imports/test/${importId}/feature-id.geojson`;
    objectKeys.push(objectKey);
    reportKeys.push(`reports/imports/${importId}/validation.json`);
    await minio.putObject('danangmap', objectKey, payload, payload.byteLength, {
      'Content-Type': 'application/geo+json',
    });
    await createDraft(layerId, revisionId, 'feature-id');
    await AppDataSource.query(
      `INSERT INTO features(id,layer_id,external_source,external_id)
       VALUES($1,$3,'old-source','old-id'),($2,$3,'preserved-source','preserved-id')`,
      [targetFeatureId, preservedFeatureId, layerId],
    );
    await AppDataSource.query(
      `INSERT INTO feature_versions(
         id,feature_id,revision_id,geometry,geometry_kind,properties,checksum,created_by
       ) VALUES
         ($1,$3,$5,ST_SetSRID(ST_Point(108.19,16.04),4326),'point','{"name":"Cũ"}',$6,$7),
         ($2,$4,$5,ST_SetSRID(ST_Point(108.195,16.045),4326),'point','{"name":"Giữ"}',$8,$7)`,
      [
        targetVersionId,
        preservedVersionId,
        targetFeatureId,
        preservedFeatureId,
        revisionId,
        randomUUID(),
        editorId,
        randomUUID(),
      ],
    );
    await AppDataSource.query(
      `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
       VALUES($1,$2,$3,1),($1,$4,$5,2)`,
      [revisionId, targetFeatureId, targetVersionId, preservedFeatureId, preservedVersionId],
    );
    await AppDataSource.query(
      `INSERT INTO import_jobs(
         id,revision_id,actor_id,object_key,file_name,size_bytes,format,mode,status,progress,
         mapping,counts,idempotency_key
       ) VALUES($1,$2,$3,$4,'feature-id.geojson',$5,'geojson','upsert','mapping_required',100,'{}','{}',$6)`,
      [importId, revisionId, editorId, objectKey, payload.byteLength, randomUUID()],
    );
    await imports.updateMapping(
      importId,
      {
        sourceCrs: 'EPSG:4326',
        geometry: { kind: 'geojson' },
        fields: {
          fid: 'feature_id',
          name: 'name',
          source: 'external_source',
          source_id: 'external_id',
        },
        unmappedColumnPolicy: 'ignore',
        upsert: { matchBy: 'feature_id' },
      },
      actor,
    );
    await imports.validate(importId, actor);
    const ready = await waitForImport(importId, 'ready');
    expect(ready.counts).toMatchObject({ total: 5, valid: 3, invalid: 2, matched: 2, new: 1 });
    const issues = await imports.issues(importId, undefined, '100', actor);
    expect(issues.data.map((issue) => issue.code)).toEqual([
      'IMPORT_FEATURE_ID_INVALID',
      'IMPORT_FEATURE_ID_WRONG_LAYER',
    ]);
    const applyKey = randomUUID();
    receiptKeys.push(applyKey);
    await imports.apply(
      importId,
      { skipInvalid: true, acknowledgedWarningCodes: [] },
      `"rev-${revisionId}-v1"`,
      applyKey,
      randomUUID(),
      actor,
    );
    await waitForImport(importId, 'completed');
    const rows = (await AppDataSource.query(
      `SELECT f.id,f.external_source AS "externalSource",f.external_id AS "externalId",
              fv.properties->>'name' AS name
       FROM revision_features rf
       JOIN features f ON f.id=rf.feature_id
       JOIN feature_versions fv ON fv.id=rf.feature_version_id
       WHERE rf.revision_id=$1 ORDER BY name`,
      [revisionId],
    )) as Array<{
      id: string;
      externalSource: string | null;
      externalId: string | null;
      name: string;
    }>;
    expect(rows.find((row) => row.id === targetFeatureId)).toEqual({
      id: targetFeatureId,
      externalSource: 'new-source',
      externalId: 'new-id',
      name: 'Đã cập nhật',
    });
    expect(rows.find((row) => row.id === preservedFeatureId)).toEqual({
      id: preservedFeatureId,
      externalSource: 'preserved-source',
      externalId: 'preserved-id',
      name: 'Giữ định danh',
    });
    expect(rows.find((row) => row.name === 'Đối tượng mới')).toMatchObject({
      externalSource: null,
      externalId: null,
      name: 'Đối tượng mới',
    });
    const createdId = rows.find((row) => row.name === 'Đối tượng mới')!.id;
    expect(createdId).not.toBe(unmatchedClientId);
    await imports.apply(
      importId,
      { skipInvalid: true, acknowledgedWarningCodes: [] },
      `"rev-${revisionId}-v1"`,
      applyKey,
      randomUUID(),
      actor,
    );
    expect(await revisionDelta(revisionId)).toEqual({ lockVersion: 2, featureCount: 3 });
    const ids = (await AppDataSource.query(
      `SELECT feature_id AS id FROM revision_features WHERE revision_id=$1 ORDER BY feature_id`,
      [revisionId],
    )) as Array<{ id: string }>;
    expect(ids.map((row) => row.id).sort()).toEqual(
      [createdId, preservedFeatureId, targetFeatureId].sort(),
    );
  });

  async function createDraft(layerId: string, revisionId: string, suffix: string) {
    await AppDataSource.query(`INSERT INTO layers(id,slug,created_by) VALUES($1,$2,$3)`, [
      layerId,
      `format-${suffix.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${layerId.slice(0, 6)}`,
      editorId,
    ]);
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
         id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,
         style,render_config,popup_config,created_by
       ) VALUES($1,$2,1,'draft',$3,'point',ARRAY['point'],'{}','{}','{}',$4)`,
      [revisionId, layerId, suffix, editorId],
    );
    await AppDataSource.query(
      `INSERT INTO layer_fields(revision_id,key,label,type,required,display_order)
       VALUES($1,'name','Tên','text',true,1)`,
      [revisionId],
    );
  }

  async function waitForImport(id: string, expectedStatus: string) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const job = await AppDataSource.getRepository(ImportJobEntity).findOneByOrFail({ id });
      if (job.status === expectedStatus) return job;
      if (job.status === 'failed') throw new Error(`Import failed: ${job.failureCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for import ${id} -> ${expectedStatus}`);
  }

  async function revisionDelta(revisionId: string) {
    const rows = (await AppDataSource.query(
      `SELECT r.lock_version AS "lockVersion",
              (SELECT count(*)::integer FROM revision_features WHERE revision_id=r.id) AS "featureCount"
       FROM layer_revisions r WHERE id=$1`,
      [revisionId],
    )) as Array<{ lockVersion: number; featureCount: number }>;
    return rows[0];
  }

  async function normalizedFeatures(revisionId: string) {
    const rows = (await AppDataSource.query(
      `SELECT fv.properties->>'name' AS name,
              ST_X(fv.geometry)::double precision AS longitude,
              ST_Y(fv.geometry)::double precision AS latitude
       FROM revision_features rf
       JOIN feature_versions fv ON fv.id=rf.feature_version_id
      WHERE rf.revision_id=$1 ORDER BY name`,
      [revisionId],
    )) as Array<{ name: string; longitude: number; latitude: number }>;
    return rows;
  }
});

async function buildFixtures(): Promise<Fixture[]> {
  const csvRows = [
    ['Đà Nẵng', '108.2022', '16.0544'],
    ['Phường Hải Châu', '108.22', '16.06'],
    ['', '108.23', '16.07'],
  ];
  const csvCoordinates = encodeWindows1258(
    ['name;longitude;latitude', ...csvRows.map((row) => row.join(';'))].join('\r\n'),
  );
  const csvWkt = encodeWindows1258(
    [
      'name;wkt',
      'Đà Nẵng;POINT (108.2022 16.0544)',
      'Phường Hải Châu;POINT (108.22 16.06)',
      ';POINT (108.23 16.07)',
    ].join('\r\n'),
  );
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Ignored').addRows([['name'], ['Không đọc']]);
  workbook.addWorksheet('DanhSach').addRows([['name', 'longitude', 'latitude'], ...csvRows]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const geojson = Buffer.from(
    JSON.stringify({
      type: 'FeatureCollection',
      features: csvRows.map(([name, longitude, latitude]) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] },
        properties: name ? { name } : {},
      })),
    }),
  );
  const kml =
    Buffer.from(`<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
    <Placemark><name>Đà Nẵng</name><Point><coordinates>108.2022,16.0544</coordinates></Point></Placemark>
    <Placemark><name>Phường Hải Châu</name><Point><coordinates>108.22,16.06</coordinates></Point></Placemark>
    <Placemark><Point><coordinates>108.23,16.07</coordinates></Point></Placemark>
  </Document></kml>`);
  const base = {
    sourceCrs: 'EPSG:4326' as const,
    fields: { name: 'name' },
    unmappedColumnPolicy: 'ignore' as const,
  };
  return [
    {
      name: 'coordinates.csv',
      format: 'csv',
      content: csvCoordinates,
      mapping: {
        ...base,
        encoding: 'windows1258',
        delimiter: 'semicolon',
        geometry: {
          kind: 'coordinates',
          longitudeColumn: 'longitude',
          latitudeColumn: 'latitude',
        },
      },
    },
    {
      name: 'geometry-wkt.csv',
      format: 'csv',
      content: csvWkt,
      mapping: {
        ...base,
        encoding: 'windows1258',
        delimiter: 'semicolon',
        geometry: { kind: 'wkt', geometryColumn: 'wkt' },
      },
    },
    {
      name: 'selected-sheet.xlsx',
      format: 'xlsx',
      content: xlsx,
      mapping: {
        ...base,
        sheet: 'DanhSach',
        geometry: {
          kind: 'coordinates',
          longitudeColumn: 'longitude',
          latitudeColumn: 'latitude',
        },
      },
    },
    {
      name: 'features.geojson',
      format: 'geojson',
      content: geojson,
      mapping: { ...base, geometry: { kind: 'geojson' } },
    },
    {
      name: 'placemarks.kml',
      format: 'kml',
      content: kml,
      mapping: { ...base, geometry: { kind: 'kml_geometry' } },
    },
  ];
}

function encodeWindows1258(value: string): Buffer {
  const toneMarks = new Set(['\u0300', '\u0301', '\u0303', '\u0309', '\u0323']);
  const representable = [...value]
    .map((character) => {
      const decomposed = [...character.normalize('NFD')];
      const base = decomposed
        .filter((part) => !toneMarks.has(part))
        .join('')
        .normalize('NFC');
      const tone = decomposed.filter((part) => toneMarks.has(part)).join('');
      return `${base}${tone}`;
    })
    .join('');
  return iconv.encode(representable, 'windows1258');
}

function geoJsonPoint(
  featureId: string,
  name: string,
  source: string | null,
  sourceId: string | null,
  longitude: number,
  latitude: number,
) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties: {
      fid: featureId,
      name,
      source,
      source_id: sourceId,
    },
  };
}
