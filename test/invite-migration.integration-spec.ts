import { randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import { InitialSpatialCms1761000000000 } from '../src/database/migrations/1761000000000-InitialSpatialCms';
import { InviteAcceptLifecycle1761000005000 } from '../src/database/migrations/1761000005000-InviteAcceptLifecycle';

jest.setTimeout(60_000);

describe('invite accept expand migration', () => {
  const schema = `test_invite_migration_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await AppDataSource.destroy();
  });

  it('keeps legacy consumed invites valid while adding user and outbox linkage', async () => {
    await AppDataSource.query(`CREATE SCHEMA "${schema}"`);
    const runner = AppDataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}",public`);
      await new InitialSpatialCms1761000000000().up(runner);
      const adminId = randomUUID();
      const inviteId = randomUUID();
      await runner.query(
        `INSERT INTO users(
          id,email,email_normalized,username,username_normalized,display_name,role,status,password_hash
        ) VALUES($1,'admin@example.gov.vn','admin@example.gov.vn','admin','admin',
          'Admin','system_admin','active','argon2-placeholder')`,
        [adminId],
      );
      await runner.query(
        `INSERT INTO invites(
          id,email,username,display_name,role,token_hash,created_by,expires_at,used_at
        ) VALUES($1,'legacy@example.gov.vn','legacy','Legacy','editor','legacy-digest',$2,
          now()+interval '1 hour',now())`,
        [inviteId, adminId],
      );
      await runner.query(
        `INSERT INTO mail_outbox(
          template_key,recipient_email,payload_encrypted,status,correlation_id
        ) VALUES('identity.invite','legacy@example.gov.vn','encrypted','sent',$1)`,
        [randomUUID()],
      );

      await new InviteAcceptLifecycle1761000005000().up(runner);

      const legacy = (await runner.query(
        `SELECT used_at,accepted_user_id FROM invites WHERE id=$1`,
        [inviteId],
      )) as Array<{ used_at: Date; accepted_user_id: string | null }>;
      expect(legacy[0]?.used_at).toBeInstanceOf(Date);
      expect(legacy[0]?.accepted_user_id).toBeNull();
      const outbox = (await runner.query(
        `SELECT invite_id FROM mail_outbox WHERE recipient_email='legacy@example.gov.vn'`,
      )) as Array<{ invite_id: string | null }>;
      expect(outbox[0]?.invite_id).toBeNull();

      const acceptedUserId = randomUUID();
      await runner.query(
        `INSERT INTO users(
          id,email,email_normalized,username,username_normalized,display_name,role,status,password_hash
        ) VALUES($1,'accepted@example.gov.vn','accepted@example.gov.vn','accepted','accepted',
          'Accepted','editor','active','argon2-placeholder')`,
        [acceptedUserId],
      );
      await runner.query('UPDATE invites SET accepted_user_id=$2 WHERE id=$1', [
        inviteId,
        acceptedUserId,
      ]);
      await runner.query('DELETE FROM users WHERE id=$1', [acceptedUserId]);
      const afterDelete = (await runner.query('SELECT accepted_user_id FROM invites WHERE id=$1', [
        inviteId,
      ])) as Array<{ accepted_user_id: string | null }>;
      expect(afterDelete[0]?.accepted_user_id).toBeNull();
    } finally {
      await runner.release();
    }
  });
});
