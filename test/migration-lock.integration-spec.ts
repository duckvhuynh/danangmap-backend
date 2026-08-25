import 'dotenv/config';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

interface PgClientLike {
  connect(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

const { Client } = jest.requireActual<{
  Client: new (options: { connectionString: string }) => PgClientLike;
}>('pg');
const execFileAsync = promisify(execFile);

describe('production migration advisory lock against Postgres', () => {
  const sourceDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `danangmap_migration_lock_${randomUUID().replaceAll('-', '')}`;
  let databaseUrl = '';
  let adminDatabaseUrl = '';

  beforeAll(async () => {
    if (!sourceDatabaseUrl) throw new Error('DATABASE_URL is required for migration lock E2E');
    const parsed = new URL(sourceDatabaseUrl);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    parsed.pathname = '/postgres';
    adminDatabaseUrl = parsed.toString();

    const admin = new Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.end();
  });

  afterAll(async () => {
    if (!adminDatabaseUrl) return;
    const admin = new Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  });

  it('serializes two concurrent migration processes on a fresh database', async () => {
    const run = () =>
      execFileAsync(process.execPath, ['dist/scripts/run-migrations-with-lock.js'], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl },
        timeout: 90_000,
      });

    await expect(Promise.all([run(), run()])).resolves.toHaveLength(2);

    const database = new Client({ connectionString: databaseUrl });
    await database.connect();
    const migrations = await database.query<{
      count: string;
      distinctCount: string;
    }>(
      `SELECT count(*)::text AS count,count(DISTINCT name)::text AS "distinctCount"
       FROM typeorm_migrations`,
    );
    expect(Number(migrations.rows[0]?.count)).toBeGreaterThan(0);
    expect(migrations.rows[0]?.count).toBe(migrations.rows[0]?.distinctCount);
    const extension = await database.query<{ installed: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis') AS installed`,
    );
    expect(extension.rows[0]?.installed).toBe(true);
    await database.end();
  });
});
