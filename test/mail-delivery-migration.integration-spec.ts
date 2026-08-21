import { randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import { InitialSpatialCms1761000000000 } from '../src/database/migrations/1761000000000-InitialSpatialCms';
import { InviteAcceptLifecycle1761000005000 } from '../src/database/migrations/1761000005000-InviteAcceptLifecycle';
import { PasswordResetSessionSecurity1761000006000 } from '../src/database/migrations/1761000006000-PasswordResetSessionSecurity';
import { MailDeliveryOutbox1761000008000 } from '../src/database/migrations/1761000008000-MailDeliveryOutbox';

jest.setTimeout(60_000);

describe('mail delivery outbox expand migration', () => {
  const schema = `test_mail_migration_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await AppDataSource.destroy();
  });

  it('preserves retryable legacy rows and scrubs terminal payloads', async () => {
    await AppDataSource.query(`CREATE SCHEMA "${schema}"`);
    const runner = AppDataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}",public`);
      await new InitialSpatialCms1761000000000().up(runner);
      await new InviteAcceptLifecycle1761000005000().up(runner);
      await new PasswordResetSessionSecurity1761000006000().up(runner);

      const pendingId = randomUUID();
      const sentId = randomUUID();
      const failedId = randomUUID();
      await runner.query(
        `INSERT INTO mail_outbox(id,template_key,recipient_email,payload_encrypted,status,
           next_attempt_at,correlation_id) VALUES
         ($1,'identity.invite','pending@example.vn','cipher-pending','sending',now(),$4),
         ($2,'identity.invite','sent@example.vn','cipher-sent','sent',NULL,$4),
         ($3,'identity.invite','failed@example.vn','cipher-failed','failed',NULL,$4)`,
        [pendingId, sentId, failedId, randomUUID()],
      );

      await new MailDeliveryOutbox1761000008000().up(runner);

      const rows = (await runner.query(
        `SELECT id,status,payload_encrypted,payload_scrubbed_at FROM mail_outbox
         WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[pendingId, sentId, failedId]],
      )) as Array<{
        id: string;
        status: string;
        payload_encrypted: string | null;
        payload_scrubbed_at: Date | null;
      }>;
      expect(rows.find((row) => row.id === pendingId)).toMatchObject({
        status: 'pending',
        payload_encrypted: 'cipher-pending',
      });
      for (const terminalId of [sentId, failedId]) {
        const row = rows.find((candidate) => candidate.id === terminalId);
        expect(row?.payload_encrypted).toBeNull();
        expect(row?.payload_scrubbed_at).toBeInstanceOf(Date);
      }
      expect(rows.find((row) => row.id === failedId)?.status).toBe('cancelled');

      const state = (await runner.query(
        'SELECT status,queue_depth FROM mail_delivery_state WHERE id=1',
      )) as Array<{ status: string; queue_depth: number }>;
      expect(state[0]).toEqual({ status: 'disabled', queue_depth: 0 });
      await expect(
        runner.query(
          `UPDATE mail_outbox SET status='sent',payload_encrypted=NULL,payload_scrubbed_at=NULL,
             sent_at=now() WHERE id=$1`,
          [pendingId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await runner.release();
    }
  });
});
