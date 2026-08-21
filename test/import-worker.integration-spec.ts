import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Client } from 'minio';
import AppDataSource from '../src/database/data-source';
import { IMPORT_INSPECT_JOB, IMPORT_QUEUE } from '../src/jobs/jobs.constants';

describe('Import worker integration', () => {
  const importId = randomUUID();
  const objectKey = `quarantine/imports/test/${importId}/sample.geojson`;
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

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await minio.putObject('danangmap', objectKey, payload, payload.byteLength, {
      'Content-Type': 'application/geo+json',
    });
    await AppDataSource.query(
      `INSERT INTO import_jobs(
        id,revision_id,actor_id,object_key,file_name,size_bytes,format,mode,status,progress,mapping,counts,idempotency_key
       ) VALUES($1,'30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',$2,
         'sample.geojson',$3,'geojson','append','uploaded',0,'{}','{}',$4)`,
      [importId, objectKey, payload.byteLength, randomUUID()],
    );
  });

  afterAll(async () => {
    await queue.close();
    await minio.removeObject('danangmap', objectKey).catch(() => undefined);
    if (AppDataSource.isInitialized) {
      await AppDataSource.query('DELETE FROM import_jobs WHERE id=$1', [importId]);
      await AppDataSource.destroy();
    }
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
});
