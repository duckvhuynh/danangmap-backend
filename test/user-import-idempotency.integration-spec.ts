import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import AppDataSource from '../src/database/data-source';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import type { StorageService } from '../src/storage/storage.service';
import { UserImportIssueEntity, UserImportJobEntity } from '../src/user-imports/user-import.entity';
import { UserImportsService } from '../src/user-imports/user-imports.service';

describe('User import durable upload idempotency', () => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const jobIds: string[] = [];
  const objects = new Map<string, Buffer>();

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  });

  afterEach(async () => {
    if (jobIds.length) {
      await AppDataSource.query('DELETE FROM user_import_jobs WHERE id=ANY($1::uuid[])', [jobIds]);
      jobIds.length = 0;
    }
    objects.clear();
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  it('persists an upload before queue failure, re-enqueues same payload, and rejects changed bytes', async () => {
    let attempts = 0;
    const queue = queueStub(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('redis unavailable')) : Promise.resolve();
    });
    const service = createService(queue);
    const key = randomUUID();
    const source = csv('durable');
    await expect(service.create(source, key, principal())).rejects.toThrow('redis unavailable');
    const persisted = await AppDataSource.getRepository(UserImportJobEntity).findOneByOrFail({
      actorId,
      idempotencyKey: key,
    });
    jobIds.push(persisted.id);
    expect(objects.has(persisted.objectKey!)).toBe(true);

    const replay = await service.create(source, key, principal());
    expect(replay.id).toBe(persisted.id);
    expect(attempts).toBe(2);
    await expect(service.create(csv('changed'), key, principal())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await AppDataSource.getRepository(UserImportJobEntity).countBy({ actorId })).toBe(1);
    expect(objects.size).toBe(1);
  });

  it('serializes 3 concurrent distinct uploads per actor and leaves only 2 jobs/objects', async () => {
    const service = createService(queueStub(() => Promise.resolve()));
    const results = await Promise.allSettled(
      ['one', 'two', 'three'].map((label) => service.create(csv(label), randomUUID(), principal())),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'USER_IMPORT_CONCURRENCY_LIMIT' },
    });
    const jobs = await AppDataSource.getRepository(UserImportJobEntity).findBy({ actorId });
    jobIds.push(...jobs.map((job) => job.id));
    expect(jobs).toHaveLength(2);
    expect(objects.size).toBe(2);
    expect(jobs.every((job) => job.objectKey && objects.has(job.objectKey))).toBe(true);
  });

  function createService(queue: Queue): UserImportsService {
    return new UserImportsService(
      AppDataSource.getRepository(UserImportJobEntity),
      AppDataSource.getRepository(UserImportIssueEntity),
      queue,
      AppDataSource,
      {
        putBuffer: (key: string, body: Buffer) => {
          objects.set(key, Buffer.from(body));
          return Promise.resolve();
        },
        remove: (key: string) => {
          objects.delete(key);
          return Promise.resolve();
        },
      } as unknown as StorageService,
      new IdempotencyService(),
    );
  }

  function queueStub(add: () => Promise<void>): Queue {
    return {
      getJob: () => Promise.resolve(undefined),
      add,
    } as unknown as Queue;
  }

  function principal() {
    return {
      id: actorId,
      role: 'system_admin',
      sessionId: randomUUID(),
      displayName: 'System Admin',
      mustChangePassword: false,
    };
  }
});

function csv(label: string): Express.Multer.File {
  const content = Buffer.from(
    `email,username,displayName,role\n${label}@example.gov.vn,${label}.user,${label},editor`,
  );
  return {
    fieldname: 'file',
    originalname: `${label}.csv`,
    encoding: '7bit',
    mimetype: 'text/csv',
    size: content.byteLength,
    buffer: content,
    destination: '',
    filename: `${label}.csv`,
    path: '',
    stream: undefined as never,
  };
}
