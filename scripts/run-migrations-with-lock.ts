import type { DataSource } from 'typeorm';
import AppDataSource from '../src/database/data-source';

export const MIGRATION_LOCK_KEY = 'danangmap:migrations';

export async function runMigrationsWithAdvisoryLock(dataSource: DataSource): Promise<void> {
  if (!dataSource.isInitialized) await dataSource.initialize();

  const lockConnection = dataSource.createQueryRunner();
  let lockAcquired = false;
  try {
    await lockConnection.connect();
    await lockConnection.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    lockAcquired = true;
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    try {
      if (lockAcquired) {
        await lockConnection.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]);
      }
    } finally {
      await lockConnection.release();
      if (dataSource.isInitialized) await dataSource.destroy();
    }
  }
}

async function main(): Promise<void> {
  await runMigrationsWithAdvisoryLock(AppDataSource);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown migration error';
    process.stderr.write(`Migration failed: ${message}\n`);
    process.exitCode = 1;
  });
}
