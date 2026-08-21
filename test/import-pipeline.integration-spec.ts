import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Client } from 'minio';
import { AppException } from '../src/common/http/app.exception';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import type { ImportFileInspector } from '../src/imports/import-file.inspector';
import { ImportJobEntity } from '../src/imports/import.entity';
import { ImportsService } from '../src/imports/imports.service';
import { IMPORT_QUEUE } from '../src/jobs/jobs.constants';
import { LayerFieldEntity, LayerRevisionEntity } from '../src/layers/layer.entities';
import type { StorageService } from '../src/storage/storage.service';

describe('GeoJSON import validation and atomic apply', () => {
  const editorId = '00000000-0000-4000-8000-000000000002';
  const layerId = randomUUID();
  const revisionId = randomUUID();
  const existingFeatureId = randomUUID();
  const existingVersionId = randomUUID();
  const importId = randomUUID();
  const emptyReplaceImportId = randomUUID();
  const objectKey = `quarantine/imports/test/${importId}/upsert.geojson`;
  const emptyReplaceObjectKey = `quarantine/imports/test/${emptyReplaceImportId}/empty-replace.geojson`;
  const applyKey = randomUUID();
  const mapping = {
    planVersion: 1,
    plan: {
      sourceCrs: 'EPSG:4326',
      geometry: { kind: 'geojson' },
      fields: {
        name: 'name',
        source: 'external_source',
        source_id: 'external_id',
      },
      unmappedColumnPolicy: 'ignore',
      upsert: { matchBy: 'external_identity' },
    },
  };
  const payload = Buffer.from(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [108.2, 16.1] },
          properties: { name: 'Đã cập nhật', source: 'fixture', source_id: 'existing' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [108.21, 16.11] },
          properties: { name: 'Mới', source: 'fixture', source_id: 'new' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [108.22, 16.12] },
          properties: { source: 'fixture', source_id: 'invalid' },
        },
      ],
    }),
  );
  const emptyReplacePayload = Buffer.from(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [108.23, 16.13] },
          properties: { source: 'fixture', source_id: 'only-invalid' },
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
  const actor = {
    id: editorId,
    role: 'editor',
    sessionId: randomUUID(),
    displayName: 'Import integration editor',
  };
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
    await minio.putObject('danangmap', objectKey, payload, payload.byteLength, {
      'Content-Type': 'application/geo+json',
    });
    await minio.putObject(
      'danangmap',
      emptyReplaceObjectKey,
      emptyReplacePayload,
      emptyReplacePayload.byteLength,
      { 'Content-Type': 'application/geo+json' },
    );
    await AppDataSource.query(`INSERT INTO layers(id,slug,created_by) VALUES($1,$2,$3)`, [
      layerId,
      `import-fixture-${layerId.slice(0, 8)}`,
      editorId,
    ]);
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
         id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,
         style,render_config,popup_config,created_by
       ) VALUES($1,$2,1,'draft','Import fixture','point',ARRAY['point'],'{}','{}','{}',$3)`,
      [revisionId, layerId, editorId],
    );
    await AppDataSource.query(
      `INSERT INTO layer_fields(revision_id,key,label,type,required,display_order)
       VALUES($1,'name','Tên','text',true,1)`,
      [revisionId],
    );
    await AppDataSource.query(
      `INSERT INTO features(id,layer_id,external_source,external_id)
       VALUES($1,$2,'fixture','existing')`,
      [existingFeatureId, layerId],
    );
    await AppDataSource.query(
      `INSERT INTO feature_versions(
         id,feature_id,revision_id,geometry,geometry_kind,properties,checksum,created_by
       ) VALUES($1,$2,$3,ST_SetSRID(ST_Point(108.19,16.09),4326),'point','{"name":"Cũ"}',$4,$5)`,
      [existingVersionId, existingFeatureId, revisionId, randomUUID(), editorId],
    );
    await AppDataSource.query(
      `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
       VALUES($1,$2,$3,1)`,
      [revisionId, existingFeatureId, existingVersionId],
    );
    await insertImport(importId, objectKey, payload.byteLength, 'upsert');
    await insertImport(
      emptyReplaceImportId,
      emptyReplaceObjectKey,
      emptyReplacePayload.byteLength,
      'replace',
    );
  });

  afterAll(async () => {
    await queue.close();
    await Promise.all([
      minio.removeObject('danangmap', objectKey).catch(() => undefined),
      minio.removeObject('danangmap', emptyReplaceObjectKey).catch(() => undefined),
      minio
        .removeObject('danangmap', `reports/imports/${importId}/validation.json`)
        .catch(() => undefined),
      minio
        .removeObject('danangmap', `reports/imports/${emptyReplaceImportId}/validation.json`)
        .catch(() => undefined),
    ]);
    if (AppDataSource.isInitialized) {
      await AppDataSource.query(
        `DELETE FROM command_receipts
         WHERE actor_id=$1 AND operation='import.apply' AND idempotency_key=$2`,
        [editorId, applyKey],
      );
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
        await manager.query(
          `DELETE FROM audit_logs
           WHERE id IN (SELECT audit_id FROM audit_layer_scopes WHERE layer_id=$1)`,
          [layerId],
        );
        await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
      });
      await AppDataSource.query('DELETE FROM import_jobs WHERE id=ANY($1::uuid[])', [
        [importId, emptyReplaceImportId],
      ]);
      await AppDataSource.query('DELETE FROM revision_changes WHERE revision_id=$1', [revisionId]);
      await AppDataSource.query('DELETE FROM revision_participants WHERE revision_id=$1', [
        revisionId,
      ]);
      await AppDataSource.query('DELETE FROM revision_features WHERE revision_id=$1', [revisionId]);
      await AppDataSource.query('DELETE FROM feature_versions WHERE revision_id=$1', [revisionId]);
      await AppDataSource.query('DELETE FROM features WHERE layer_id=$1', [layerId]);
      await AppDataSource.query('DELETE FROM layer_revisions WHERE id=$1', [revisionId]);
      await AppDataSource.query('DELETE FROM layers WHERE id=$1', [layerId]);
      await AppDataSource.destroy();
    }
  });

  it('validates once under concurrent requests and persists capped row issues', async () => {
    const [first, replay] = await Promise.all([
      imports.validate(importId, actor),
      imports.validate(importId, actor),
    ]);
    expect([first.status, replay.status]).toEqual(expect.arrayContaining(['validating']));
    const completed = await waitForImport(importId, 'ready');
    expect(completed.counts).toMatchObject({ total: 3, valid: 2, invalid: 1, matched: 1, new: 1 });
    const issues = await imports.issues(importId, undefined, '100', actor);
    expect(issues.data).toEqual([
      expect.objectContaining({ rowNumber: 3, severity: 'error', code: 'SCHEMA_VIOLATION' }),
    ]);
    expect(await queue.getJob(`validate-${importId}-1`)).not.toBeNull();
  });

  it('keeps the revision atomic on errors and applies/replays upsert exactly once', async () => {
    await expectAppCode(
      imports.apply(
        importId,
        { skipInvalid: false, acknowledgedWarningCodes: [] },
        `"rev-${revisionId}-v1"`,
        randomUUID(),
        randomUUID(),
        actor,
      ),
      'IMPORT_HAS_ERRORS',
    );
    expect(await revisionState()).toMatchObject({ lockVersion: 1, cursorSeq: '0', links: 1 });

    const [first, replay] = await Promise.all([
      imports.apply(
        importId,
        { skipInvalid: true, acknowledgedWarningCodes: [] },
        `"rev-${revisionId}-v1"`,
        applyKey,
        randomUUID(),
        actor,
      ),
      imports.apply(
        importId,
        { skipInvalid: true, acknowledgedWarningCodes: [] },
        `"rev-${revisionId}-v1"`,
        applyKey,
        randomUUID(),
        actor,
      ),
    ]);
    expect([first.status, replay.status]).toEqual(expect.arrayContaining(['applying']));
    const completed = await waitForImport(importId, 'completed');
    expect(completed.counts).toMatchObject({ applied: 2, skipped: 1 });
    expect(await queue.getJob(`apply-${importId}-${applyKey}`)).not.toBeNull();
    expect(await revisionState()).toMatchObject({ lockVersion: 2, cursorSeq: '2', links: 2 });
    const participants = (await AppDataSource.query(
      `SELECT participation_type FROM revision_participants
       WHERE revision_id=$1 AND user_id=$2`,
      [revisionId, editorId],
    )) as Array<{ participation_type: string }>;
    expect(participants).toEqual([{ participation_type: 'edit' }]);

    const changes = (await AppDataSource.query(
      `SELECT server_cursor::text AS cursor,operation FROM revision_changes
       WHERE revision_id=$1 ORDER BY server_cursor`,
      [revisionId],
    )) as Array<{ cursor: string; operation: string }>;
    expect(changes).toEqual([
      { cursor: '1', operation: 'update' },
      { cursor: '2', operation: 'create' },
    ]);

    await imports.apply(
      importId,
      { skipInvalid: true, acknowledgedWarningCodes: [] },
      `"rev-${revisionId}-v1"`,
      applyKey,
      randomUUID(),
      actor,
    );
    expect(await revisionState()).toMatchObject({ lockVersion: 2, cursorSeq: '2', links: 2 });
    await expectAppCode(
      imports.apply(
        importId,
        { skipInvalid: false, acknowledgedWarningCodes: [] },
        `"rev-${revisionId}-v1"`,
        applyKey,
        randomUUID(),
        actor,
      ),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('rejects an all-invalid replace without deleting existing draft features', async () => {
    await Promise.all([
      imports.validate(emptyReplaceImportId, actor),
      imports.validate(emptyReplaceImportId, actor),
    ]);
    const validated = await waitForImport(emptyReplaceImportId, 'ready');
    expect(validated.counts).toMatchObject({ valid: 0, invalid: 1 });
    const before = await revisionState();
    await expectAppCode(
      imports.apply(
        emptyReplaceImportId,
        { skipInvalid: true, acknowledgedWarningCodes: [] },
        `"rev-${revisionId}-v2"`,
        randomUUID(),
        randomUUID(),
        actor,
      ),
      'IMPORT_NO_VALID_ROWS',
    );
    expect(await revisionState()).toEqual(before);
  });

  async function insertImport(id: string, key: string, size: number, mode: 'upsert' | 'replace') {
    await AppDataSource.query(
      `INSERT INTO import_jobs(
         id,revision_id,actor_id,object_key,file_name,size_bytes,format,mode,status,progress,
         mapping,counts,idempotency_key
       ) VALUES($1,$2,$3,$4,'fixture.geojson',$5,'geojson',$6,'mapping_required',100,$7,'{}',$8)`,
      [id, revisionId, editorId, key, size, mode, JSON.stringify(mapping), randomUUID()],
    );
  }

  async function waitForImport(id: string, expectedStatus: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = await AppDataSource.getRepository(ImportJobEntity).findOneByOrFail({ id });
      if (job.status === expectedStatus) return job;
      if (job.status === 'failed') throw new Error(`Import failed: ${job.failureCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for import ${id} -> ${expectedStatus}`);
  }

  async function revisionState() {
    const rows = (await AppDataSource.query(
      `SELECT r.lock_version AS "lockVersion",r.cursor_seq::text AS "cursorSeq",
              (SELECT count(*)::integer FROM revision_features WHERE revision_id=r.id) AS links
       FROM layer_revisions r WHERE r.id=$1`,
      [revisionId],
    )) as Array<{ lockVersion: number; cursorSeq: string; links: number }>;
    return rows[0];
  }

  async function expectAppCode(promise: Promise<unknown>, code: string): Promise<void> {
    try {
      await promise;
      throw new Error(`Expected ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ code });
    }
  }
});
