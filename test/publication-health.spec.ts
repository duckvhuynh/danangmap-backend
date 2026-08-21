import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { HealthController } from '../src/health/health.controller';
import type { GeoServiceAdapter } from '../src/public-api/geo-service.adapter';
import type { StorageService } from '../src/storage/storage.service';

describe('publication readiness truth table', () => {
  it.each([
    {
      name: 'both loops fresh and healthy',
      row: state(true, true, true, null, null),
      expected: 'up',
    },
    {
      name: 'worker heartbeat stale',
      row: state(false, true, true, null, null),
      expected: 'degraded',
    },
    {
      name: 'activation heartbeat fresh but recovery sweep stale',
      row: state(true, false, true, null, null),
      expected: 'degraded',
    },
    {
      name: 'dispatcher sweep stale',
      row: state(true, true, false, null, null),
      expected: 'degraded',
    },
    {
      name: 'worker failed while dispatcher is healthy',
      row: state(true, true, true, 'PUBLICATION_DEPENDENCY_UNAVAILABLE', null),
      expected: 'degraded',
    },
    {
      name: 'dispatcher failed while worker is healthy',
      row: state(true, true, true, null, 'PUBLICATION_QUEUE_UNAVAILABLE'),
      expected: 'degraded',
    },
  ])('reports publication $expected when $name', async ({ row, expected }) => {
    const dataSource = {
      query: jest.fn((sql: string) => {
        if (sql.includes('mail_delivery_state')) {
          return Promise.resolve([{ status: 'up', fresh: true }]);
        }
        if (sql.includes('publication_worker_state')) return Promise.resolve([row]);
        return Promise.resolve([]);
      }),
      showMigrations: jest.fn().mockResolvedValue(false),
    } as unknown as DataSource;
    const storage = { ping: jest.fn().mockResolvedValue(undefined) } as unknown as StorageService;
    const config = {
      get: jest.fn().mockReturnValue(undefined),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string | number | boolean> = {
          'redis.host': '127.0.0.1',
          'redis.port': 6379,
          'app.version': 'test',
          'mail.workerHeartbeatStaleSeconds': 120,
          'publication.asyncEnabled': true,
          'publication.workerStaleSeconds': 30,
        };
        return values[key];
      }),
    } as unknown as ConfigService;
    const geoService = { healthStatus: 'disabled' } as unknown as GeoServiceAdapter;
    const controller = new HealthController(dataSource, storage, config, geoService);
    const redis = {
      status: 'ready',
      ping: jest.fn().mockResolvedValue('PONG'),
      connect: jest.fn().mockResolvedValue(undefined),
    } as unknown as Redis;
    (controller as unknown as { redis: Redis }).redis = redis;

    const response = await controller.ready();
    expect(response.checks.publication).toBe(expected);
  });

  function state(
    workerFresh: boolean,
    recoveryFresh: boolean,
    dispatchFresh: boolean,
    workerErrorCode: string | null,
    dispatchErrorCode: string | null,
  ) {
    return { workerFresh, recoveryFresh, dispatchFresh, workerErrorCode, dispatchErrorCode };
  }
});
