import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import { ImportFileInspector } from '../src/imports/import-file.inspector';
import { ImportJobEntity } from '../src/imports/import.entity';
import type { CreateImportDto } from '../src/imports/import.dto';
import { ImportsService } from '../src/imports/imports.service';
import { LayerFieldEntity, LayerRevisionEntity } from '../src/layers/layer.entities';
import type { StorageService } from '../src/storage/storage.service';

describe('Import upload idempotency integration', () => {
  const editorId = '00000000-0000-4000-8000-000000000002';
  const layerId = randomUUID();
  const revisionId = randomUUID();
  const actor = {
    id: editorId,
    role: 'editor',
    sessionId: randomUUID(),
    displayName: 'Import editor',
  };
  const queue = {
    getJob: jest.fn(),
    add: jest.fn(),
  };
  const storage = {
    putBuffer: jest.fn(),
    remove: jest.fn(),
  };
  let imports: ImportsService;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(`INSERT INTO layers(id,slug,created_by) VALUES($1,$2,$3)`, [
      layerId,
      `upload-idempotency-${layerId.slice(0, 8)}`,
      editorId,
    ]);
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
         id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,
         style,render_config,popup_config,created_by
       ) VALUES($1,$2,1,'draft','Upload idempotency','point',ARRAY['point'],'{}','{}','{}',$3)`,
      [revisionId, layerId, editorId],
    );
    imports = new ImportsService(
      AppDataSource.getRepository(ImportJobEntity),
      AppDataSource.getRepository(LayerRevisionEntity),
      AppDataSource.getRepository(LayerFieldEntity),
      queue as unknown as Queue,
      AppDataSource,
      storage as unknown as StorageService,
      new ImportFileInspector(),
      new IdempotencyService(),
    );
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.query('DELETE FROM import_jobs WHERE revision_id=$1', [revisionId]);
      await AppDataSource.query('DELETE FROM layer_revisions WHERE id=$1', [revisionId]);
      await AppDataSource.query('DELETE FROM layers WHERE id=$1', [layerId]);
      await AppDataSource.destroy();
    }
  });

  beforeEach(() => {
    queue.getJob.mockReset().mockResolvedValue(null);
    queue.add.mockReset().mockResolvedValue({});
    storage.putBuffer.mockReset().mockResolvedValue(undefined);
    storage.remove.mockReset().mockResolvedValue(undefined);
  });

  it('recovers from enqueue failure and rejects a changed upload under the same key', async () => {
    const key = randomUUID();
    const clientRequestId = randomUUID();
    const dto: CreateImportDto = { mode: 'append', format: 'geojson', clientRequestId };
    const file = geoJsonFile('original.geojson', 108.2);
    queue.add.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(
      imports.create(revisionId, file, dto, `"rev-${revisionId}-v1"`, key, actor),
    ).rejects.toThrow('queue unavailable');
    expect(await AppDataSource.getRepository(ImportJobEntity).countBy({ revisionId })).toBe(1);

    const replay = await imports.create(
      revisionId,
      file,
      dto,
      `"rev-${revisionId}-v1"`,
      key,
      actor,
    );
    expect(replay).toMatchObject({
      revisionId,
      status: 'uploaded',
      inspection: { parserStatus: 'pending', sheets: [] },
    });
    expect(storage.putBuffer).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledTimes(2);

    await expect(
      imports.create(
        revisionId,
        geoJsonFile('changed.geojson', 108.21),
        dto,
        `"rev-${revisionId}-v1"`,
        key,
        actor,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      imports.create(
        revisionId,
        file,
        { ...dto, mode: 'replace' },
        `"rev-${revisionId}-v1"`,
        key,
        actor,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await AppDataSource.getRepository(ImportJobEntity).countBy({ revisionId })).toBe(1);
    await expect(
      imports.get(replay.id, {
        ...actor,
        role: 'system_admin',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'IMPORT_FORBIDDEN' });
  });

  it('retries an existing failed BullMQ job without attempting a duplicate add', async () => {
    const existing = await AppDataSource.getRepository(ImportJobEntity).findOneByOrFail({
      revisionId,
    });
    const retry = jest.fn().mockResolvedValue(undefined);
    queue.getJob.mockResolvedValue({ getState: jest.fn().mockResolvedValue('failed'), retry });
    const file = geoJsonFile(existing.fileName, 108.2);

    const replay = await imports.create(
      revisionId,
      file,
      {
        mode: existing.mode,
        format: existing.format,
        clientRequestId: String(existing.mapping.clientRequestId),
      },
      `"rev-${revisionId}-v1"`,
      existing.idempotencyKey,
      actor,
    );
    expect(replay.id).toBe(existing.id);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('removes the losing object when concurrent inserts race on one idempotency key', async () => {
    const key = randomUUID();
    const dto: CreateImportDto = {
      mode: 'append',
      format: 'geojson',
      clientRequestId: randomUUID(),
    };
    const file = geoJsonFile('concurrent.geojson', 108.22);
    let arrivals = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.putBuffer.mockImplementation(async () => {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await gate;
    });

    const [first, second] = await Promise.all([
      imports.create(revisionId, file, dto, `"rev-${revisionId}-v1"`, key, actor),
      imports.create(revisionId, file, dto, `"rev-${revisionId}-v1"`, key, actor),
    ]);
    expect(first.id).toBe(second.id);
    expect(storage.putBuffer).toHaveBeenCalledTimes(2);
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(await AppDataSource.getRepository(ImportJobEntity).countBy({ revisionId })).toBe(2);
  });
});

function geoJsonFile(name: string, longitude: number): Express.Multer.File {
  const buffer = Buffer.from(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [longitude, 16.05] },
          properties: { name: 'Đà Nẵng' },
        },
      ],
    }),
  );
  return {
    originalname: name,
    mimetype: 'application/geo+json',
    size: buffer.byteLength,
    buffer,
  } as Express.Multer.File;
}
