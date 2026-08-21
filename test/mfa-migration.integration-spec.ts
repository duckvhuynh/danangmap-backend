import { randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import { InitialSpatialCms1761000000000 } from '../src/database/migrations/1761000000000-InitialSpatialCms';
import { MfaEnrollmentRecovery1761000004000 } from '../src/database/migrations/1761000004000-MfaEnrollmentRecovery';

jest.setTimeout(60_000);

describe('MFA expand migration', () => {
  const schema = `test_mfa_migration_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await AppDataSource.destroy();
    }
  });

  it('backfills an enabled legacy user into the canonical verified method table', async () => {
    await AppDataSource.query(`CREATE SCHEMA "${schema}"`);
    const runner = AppDataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}",public`);
      await new InitialSpatialCms1761000000000().up(runner);
      const userId = randomUUID();
      const encryptedSecret = 'legacy.encrypted.secret';
      await runner.query(
        `INSERT INTO users(
          id,email,email_normalized,username,username_normalized,display_name,role,status,
          password_hash,mfa_enabled,mfa_secret_encrypted
        ) VALUES($1,'legacy@example.gov.vn','legacy@example.gov.vn','legacy-user','legacy-user',
          'Legacy user','editor','active','argon2-placeholder',true,$2)`,
        [userId, encryptedSecret],
      );

      await new MfaEnrollmentRecovery1761000004000().up(runner);

      const rows = (await runner.query(
        `SELECT status,secret_encrypted,verified_at,last_used_time_step
         FROM user_mfa_methods WHERE user_id=$1`,
        [userId],
      )) as Array<{
        status: string;
        secret_encrypted: string;
        verified_at: Date | null;
        last_used_time_step: string | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'verified',
        secret_encrypted: encryptedSecret,
        last_used_time_step: null,
      });
      expect(rows[0]?.verified_at).toBeInstanceOf(Date);
    } finally {
      await runner.release();
    }
  });
});
