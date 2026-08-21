import type { Queue } from 'bullmq';
import type { ConfigService } from '@nestjs/config';
import type { PublicationJobRepository } from '../src/publications/publication-job.repository';
import { PublicationRecoveryService } from '../src/publications/publication-recovery.service';
import type { PublicationWorkerRepository } from '../src/publications/publication-worker.repository';

describe('publication recovery scheduling', () => {
  it('awaits the durable failed-sweep health write before shutdown completes', async () => {
    const heartbeat = deferred<void>();
    const errorStarted = deferred<void>();
    const worker = {
      requeueExpiredLeases: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      workerHeartbeat: jest.fn(async (code: string | null) => {
        expect(code).toBe('PUBLICATION_DEPENDENCY_UNAVAILABLE');
        errorStarted.resolve();
        await heartbeat.promise;
      }),
    };
    const service = recoveryService(worker, 60_000);
    service.onModuleInit();
    await errorStarted.promise;

    let shutdownCompleted = false;
    const shutdown = service.onApplicationShutdown().then(() => {
      shutdownCompleted = true;
    });
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);

    heartbeat.resolve();
    await shutdown;
    expect(shutdownCompleted).toBe(true);
    expect(worker.workerHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('does not start a later successful sweep until the failed-sweep write finishes', async () => {
    const heartbeat = deferred<void>();
    const errorStarted = deferred<void>();
    const successfulHeartbeat = deferred<void>();
    const events: string[] = [];
    let sweep = 0;
    const worker = {
      requeueExpiredLeases: jest.fn(() => {
        sweep += 1;
        if (sweep === 1) return Promise.reject(new Error('redis unavailable'));
        return Promise.resolve([]);
      }),
      workerHeartbeat: jest.fn(async (code: string | null) => {
        if (code) {
          events.push('error-start');
          errorStarted.resolve();
          await heartbeat.promise;
          events.push('error-finished');
          return;
        }
        events.push('success');
        successfulHeartbeat.resolve();
      }),
    };
    const service = recoveryService(worker, 10);
    service.onModuleInit();
    await errorStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(worker.requeueExpiredLeases).toHaveBeenCalledTimes(1);

    heartbeat.resolve();
    await successfulHeartbeat.promise;
    await service.onApplicationShutdown();
    expect(events).toEqual(['error-start', 'error-finished', 'success']);
  });

  function recoveryService(
    worker: Pick<PublicationWorkerRepository, 'requeueExpiredLeases' | 'workerHeartbeat'>,
    intervalMs: number,
  ): PublicationRecoveryService {
    const queue = {
      getJob: jest.fn().mockResolvedValue(undefined),
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue;
    const jobs = {
      queuedForReconciliation: jest.fn().mockResolvedValue([]),
    } as unknown as PublicationJobRepository;
    const config = {
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, number> = {
          'publication.recoveryIntervalMs': intervalMs,
          'publication.dispatchBatchSize': 1,
          'publication.maxAttempts': 5,
          'publication.retryBackoffMs': 1,
        };
        return values[key];
      }),
    } as unknown as ConfigService;
    return new PublicationRecoveryService(
      queue,
      jobs,
      worker as PublicationWorkerRepository,
      config,
    );
  }

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }
});
