import type { DataSource, QueryRunner } from 'typeorm';
import {
  MIGRATION_LOCK_KEY,
  runMigrationsWithAdvisoryLock,
} from '../scripts/run-migrations-with-lock';

describe('production migration advisory lock', () => {
  it('holds the session lock while migrations run and releases resources', async () => {
    const events: string[] = [];
    const connect = jest.fn(() => {
      events.push('connection:open');
      return Promise.resolve();
    });
    const query = jest.fn((sql: string, values: unknown[]) => {
      events.push(sql.includes('unlock') ? 'lock:release' : 'lock:acquire');
      expect(values).toEqual([MIGRATION_LOCK_KEY]);
      return Promise.resolve();
    });
    const release = jest.fn(() => {
      events.push('connection:release');
      return Promise.resolve();
    });
    const queryRunner = {
      connect,
      query,
      release,
    } as unknown as QueryRunner;
    const initialize = jest.fn(function (this: { isInitialized: boolean }) {
      this.isInitialized = true;
      events.push('datasource:initialize');
      return Promise.resolve();
    });
    const runMigrations = jest.fn(() => {
      events.push('migrations:run');
      return Promise.resolve([]);
    });
    const destroy = jest.fn(function (this: { isInitialized: boolean }) {
      this.isInitialized = false;
      events.push('datasource:destroy');
      return Promise.resolve();
    });
    const dataSource = {
      isInitialized: false,
      initialize,
      createQueryRunner: jest.fn(() => queryRunner),
      runMigrations,
      destroy,
    } as unknown as DataSource;

    await runMigrationsWithAdvisoryLock(dataSource);

    expect(runMigrations).toHaveBeenCalledWith({ transaction: 'each' });
    expect(events).toEqual([
      'datasource:initialize',
      'connection:open',
      'lock:acquire',
      'migrations:run',
      'lock:release',
      'connection:release',
      'datasource:destroy',
    ]);
  });

  it('releases the lock and datasource when a migration fails', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const release = jest.fn().mockResolvedValue(undefined);
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query,
      release,
    } as unknown as QueryRunner;
    const destroy = jest.fn(function (this: { isInitialized: boolean }) {
      this.isInitialized = false;
      return Promise.resolve();
    });
    const dataSource = {
      isInitialized: true,
      createQueryRunner: jest.fn(() => queryRunner),
      runMigrations: jest.fn().mockRejectedValue(new Error('migration failed')),
      destroy,
    } as unknown as DataSource;

    await expect(runMigrationsWithAdvisoryLock(dataSource)).rejects.toThrow('migration failed');
    expect(query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock(hashtext($1))', [
      MIGRATION_LOCK_KEY,
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the datasource without attempting unlock when lock connection fails', async () => {
    const query = jest.fn();
    const release = jest.fn().mockResolvedValue(undefined);
    const queryRunner = {
      connect: jest.fn().mockRejectedValue(new Error('connection failed')),
      query,
      release,
    } as unknown as QueryRunner;
    const destroy = jest.fn(function (this: { isInitialized: boolean }) {
      this.isInitialized = false;
      return Promise.resolve();
    });
    const dataSource = {
      isInitialized: true,
      createQueryRunner: jest.fn(() => queryRunner),
      runMigrations: jest.fn(),
      destroy,
    } as unknown as DataSource;

    await expect(runMigrationsWithAdvisoryLock(dataSource)).rejects.toThrow('connection failed');
    expect(query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
