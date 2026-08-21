import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import ExcelJS from 'exceljs';
import { Client } from 'minio';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import type { ImportFileInspector } from '../src/imports/import-file.inspector';
import { ImportJobEntity } from '../src/imports/import.entity';
import { ImportsService } from '../src/imports/imports.service';
import { IMPORT_INSPECT_JOB, IMPORT_QUEUE } from '../src/jobs/jobs.constants';
import { LayerFieldEntity, LayerRevisionEntity } from '../src/layers/layer.entities';
import type { StorageService } from '../src/storage/storage.service';

describe('Import worker integration', () => {
  const importId = randomUUID();
  const xlsxImportId = randomUUID();
  const oversizedXlsxImportId = randomUUID();
  const objectKey = `quarantine/imports/test/${importId}/sample.geojson`;
  const xlsxObjectKey = `quarantine/imports/test/${xlsxImportId}/selected-sheet.xlsx`;
  const oversizedXlsxObjectKey = `quarantine/imports/test/${oversizedXlsxImportId}/sample.xlsx`;
  const payload = Buffer.from(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [108.2, 16.1] },
          properties: {},
        },
      ],
    }),
  );
  const oversizedXlsxPayload = Buffer.alloc(46);
  oversizedXlsxPayload.writeUInt32LE(0x02014b50, 0);
  oversizedXlsxPayload.writeUInt32LE(250 * 1024 * 1024 + 1, 24);
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
  let xlsxPayload: Buffer;
  let imports: ImportsService;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Ignored').addRow(['name']);
    workbook.addWorksheet('DanhSach').addRows([
      ['name', 'longitude', 'latitude'],
      ['Đà Nẵng', 108.2022, 16.0544],
    ]);
    xlsxPayload = Buffer.from(await workbook.xlsx.writeBuffer());
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
    await minio.putObject('danangmap', objectKey, payload, payload.byteLength, {
      'Content-Type': 'application/geo+json',
    });
    await minio.putObject('danangmap', xlsxObjectKey, xlsxPayload, xlsxPayload.byteLength, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    await minio.putObject(
      'danangmap',
      oversizedXlsxObjectKey,
      oversizedXlsxPayload,
      oversizedXlsxPayload.byteLength,
      { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    );
    await AppDataSource.query(
      `INSERT INTO import_jobs(
        id,revision_id,actor_id,object_key,file_name,size_bytes,format,mode,status,progress,mapping,counts,idempotency_key
       ) VALUES($1,'30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',$2,
         'selected-sheet.xlsx',$3,'xlsx','append','uploaded',0,'{}','{}',$4)`,
      [xlsxImportId, xlsxObjectKey, xlsxPayload.byteLength, randomUUID()],
    );
    await AppDataSource.query(
      `INSERT INTO import_jobs(
        id,revision_id,actor_id,object_key,file_name,size_bytes,format,mode,status,progress,mapping,counts,idempotency_key
       ) VALUES($1,'30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',$2,
         'sample.geojson',$3,'geojson','append','uploaded',0,'{}','{}',$4)`,
      [importId, objectKey, payload.byteLength, randomUUID()],
    );
    await AppDataSource.query(
      `INSERT INTO import_jobs(
        id,revision_id,actor_id,object_key,file_name,size_bytes,format,mode,status,progress,mapping,counts,idempotency_key
       ) VALUES($1,'30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',$2,
         'sample.xlsx',$3,'xlsx','append','uploaded',0,'{}','{}',$4)`,
      [
        oversizedXlsxImportId,
        oversizedXlsxObjectKey,
        oversizedXlsxPayload.byteLength,
        randomUUID(),
      ],
    );
  });

  afterAll(async () => {
    await queue.close();
    await minio.removeObject('danangmap', objectKey).catch(() => undefined);
    await minio.removeObject('danangmap', xlsxObjectKey).catch(() => undefined);
    await minio.removeObject('danangmap', oversizedXlsxObjectKey).catch(() => undefined);
    if (AppDataSource.isInitialized) {
      await AppDataSource.query('DELETE FROM import_jobs WHERE id = ANY($1::uuid[])', [
        [importId, xlsxImportId, oversizedXlsxImportId],
      ]);
      await AppDataSource.destroy();
    }
  });

  it('exposes inspected XLSX sheet names and effective parser limits through GET', async () => {
    await queue.add(
      IMPORT_INSPECT_JOB,
      { importId: xlsxImportId },
      { jobId: `integration-${xlsxImportId}` },
    );
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [result] = (await AppDataSource.query('SELECT status FROM import_jobs WHERE id=$1', [
        xlsxImportId,
      ])) as Array<{ status: string }>;
      if (result?.status === 'mapping_required') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const response = await imports.get(xlsxImportId, {
      id: '00000000-0000-4000-8000-000000000002',
      role: 'editor',
      sessionId: randomUUID(),
      displayName: 'Editor',
    });
    expect(response).toMatchObject({
      status: 'mapping_required',
      inspection: {
        parserStatus: 'inspected',
        sheets: ['Ignored', 'DanhSach'],
        limits: {
          maxRecords: 100_000,
          maxVerticesPerFeature: 100_000,
          maxVerticesPerJob: 2_000_000,
          maxExpandedBytes: 250 * 1024 * 1024,
          maxIssues: 20_000,
        },
      },
    });
  });

  it('moves an uploaded object through worker inspection', async () => {
    await queue.add(IMPORT_INSPECT_JOB, { importId }, { jobId: `integration-${importId}` });
    let result: Array<{ status: string; progress: number; mapping: Record<string, unknown> }> = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      result = (await AppDataSource.query(
        'SELECT status,progress,mapping FROM import_jobs WHERE id=$1',
        [importId],
      )) as typeof result;
      if (result[0]?.status === 'mapping_required') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(result[0]).toMatchObject({ status: 'mapping_required', progress: 100 });
    const inspection = result[0]?.mapping.inspection;
    expect(inspection).toBeDefined();
    expect((inspection as Record<string, unknown>).maxRecords).toBe(100_000);
  });

  it('rejects an XLSX archive whose declared expansion exceeds 250 MiB', async () => {
    await queue.add(
      IMPORT_INSPECT_JOB,
      { importId: oversizedXlsxImportId },
      { jobId: `integration-${oversizedXlsxImportId}` },
    );
    let result: Array<{ status: string; failure_code: string | null }> = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      result = (await AppDataSource.query(
        'SELECT status,failure_code FROM import_jobs WHERE id=$1',
        [oversizedXlsxImportId],
      )) as typeof result;
      if (result[0]?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(result[0]).toEqual({
      status: 'failed',
      failure_code: 'IMPORT_EXPANDED_SIZE_LIMIT',
    });
  });
});
