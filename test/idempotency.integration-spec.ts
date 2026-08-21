import { randomUUID } from 'node:crypto';
import { AppException } from '../src/common/http/app.exception';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';

describe('Durable command receipts', () => {
  const actorId = '00000000-0000-4000-8000-000000000002';
  const key = randomUUID();
  const operation = 'test.concurrent_create';
  let executions = 0;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.query(
        'DELETE FROM command_receipts WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3',
        [actorId, operation, key],
      );
      await AppDataSource.destroy();
    }
  });

  it('executes concurrent identical commands once and survives service restart', async () => {
    const firstService = new IdempotencyService();
    const execute = async (service: IdempotencyService, payload: Record<string, unknown>) => {
      const digest = service.digest(payload);
      return AppDataSource.transaction(async (manager) => {
        const claim = await service.claim<{ id: string; value: string }>(
          manager,
          actorId,
          operation,
          key,
          digest,
        );
        if (!claim.owner) {
          if (claim.response) return claim.response;
          throw new Error('receipt unexpectedly pending');
        }
        executions += 1;
        await manager.query('SELECT pg_sleep(0.1)');
        const response = { id: randomUUID(), value: String(payload.value) };
        await service.complete(manager, actorId, operation, key, response, 201, '"etag-v1"');
        return response;
      });
    };

    const [first, concurrentReplay] = await Promise.all([
      execute(firstService, { value: 'same', nested: { b: 2, a: 1 } }),
      execute(firstService, { nested: { a: 1, b: 2 }, value: 'same' }),
    ]);
    expect(executions).toBe(1);
    expect(concurrentReplay).toEqual(first);

    const restartedService = new IdempotencyService();
    await expect(
      execute(restartedService, { value: 'same', nested: { a: 1, b: 2 } }),
    ).resolves.toEqual(first);
    expect(executions).toBe(1);

    try {
      await execute(restartedService, { value: 'changed', nested: { a: 1, b: 2 } });
      throw new Error('Expected idempotency conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    }
  });
});
