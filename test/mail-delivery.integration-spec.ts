import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import AppDataSource from '../src/database/data-source';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { MAIL_QUEUE } from '../src/jobs/jobs.constants';
import { MailDeliveryService } from '../src/mail/mail-delivery.service';
import { MailTemplateService } from '../src/mail/mail-template.service';
import type { SmtpMailerService } from '../src/mail/smtp-mailer.service';
import { MailDeliveryError } from '../src/mail/mail.types';

const execFileAsync = promisify(execFile);
const adminId = '00000000-0000-4000-8000-000000000001';

jest.setTimeout(60_000);

describe('transactional mail delivery state machine', () => {
  const ids: string[] = [];
  const inviteIds: string[] = [];
  const send = jest.fn();
  let queue: Queue;
  let service: MailDeliveryService;
  let crypto: CryptoService;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    queue = new Queue(MAIL_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: null,
      },
      prefix: 'danangmap:q',
    });
    await queue.pause();
    const config = new ConfigService({
      FIELD_ENCRYPTION_KEY:
        process.env.FIELD_ENCRYPTION_KEY ?? 'local-only-field-encryption-key-change-in-production',
      SESSION_PEPPER:
        process.env.SESSION_PEPPER ?? 'local-only-session-pepper-change-in-production',
      mail: {
        claimLeaseSeconds: 15,
        maxAttempts: 2,
        perRecipientIntervalSeconds: 1,
        backoffBaseSeconds: 1,
        backoffMaxSeconds: 10,
        backoffJitterPercent: 0,
        failedPayloadRetentionHours: 1,
        smtpProbeIntervalMs: 1_000,
      },
    });
    crypto = new CryptoService(config);
    const smtp = {
      isEnabled: () => true,
      verify: jest.fn().mockResolvedValue(undefined),
      send,
    } as unknown as SmtpMailerService;
    service = new MailDeliveryService(AppDataSource, new MailTemplateService(crypto), smtp, config);
  });

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({
      messageId: `<accepted-${randomUUID()}@danangmap.test>`,
      smtpStatus: 250,
    });
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
        await manager.query(
          `DELETE FROM audit_logs WHERE resource_type='mail_outbox' AND resource_id=ANY($1::uuid[])`,
          [ids],
        );
        await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
        await manager.query('DELETE FROM mail_outbox WHERE id=ANY($1::uuid[])', [ids]);
        await manager.query('DELETE FROM invites WHERE id=ANY($1::uuid[])', [inviteIds]);
      });
      await AppDataSource.destroy();
    }
    await queue.resume();
    await queue.close();
  });

  it('claims a concurrent duplicate once and scrubs the confirmed delivery', async () => {
    const fixture = await insertOutbox('concurrent');
    const before = await deliveryState();
    send.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { messageId: `<danangmap-${fixture.outboxId}@danangmap.test>`, smtpStatus: 250 };
    });
    await Promise.all([service.deliver(fixture.outboxId), service.deliver(fixture.outboxId)]);
    expect(send).toHaveBeenCalledTimes(1);
    const row = await outbox(fixture.outboxId);
    expect(row).toMatchObject({ status: 'sent', payload_encrypted: null, attempts: 1 });
    expect(row.payload_scrubbed_at).toBeInstanceOf(Date);
    expect(row.provider_message_id).toBe(`<danangmap-${fixture.outboxId}@danangmap.test>`);
    const after = await deliveryState();
    expect(Number(after.sent_count) - Number(before.sent_count)).toBe(1);
    expect(typeof after.queue_depth).toBe('number');
    expect(typeof after.oldest_age_seconds).toBe('number');
  });

  it('backs off transient errors, retains failed payloads, and scrubs at bounded retention', async () => {
    const transient = await insertOutbox('transient');
    send.mockRejectedValueOnce(new MailDeliveryError('MAIL_SMTP_UNREACHABLE', 'transient', null));
    await service.deliver(transient.outboxId);
    const retry = await outbox(transient.outboxId);
    expect(retry).toMatchObject({ status: 'pending', attempts: 1 });
    expect(retry.payload_encrypted).not.toBeNull();
    expect(new Date(retry.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());

    const permanent = await insertOutbox('permanent');
    send.mockRejectedValueOnce(
      new MailDeliveryError('MAIL_SMTP_RECIPIENT_REJECTED', 'permanent', 550),
    );
    await service.deliver(permanent.outboxId);
    expect(await outbox(permanent.outboxId)).toMatchObject({
      status: 'failed',
      last_error_code: 'MAIL_SMTP_RECIPIENT_REJECTED',
      last_smtp_status: 550,
    });
    await AppDataSource.query(
      `UPDATE mail_outbox SET failed_at=now()-interval '2 hours' WHERE id=$1`,
      [permanent.outboxId],
    );
    await service.sweep();
    const dead = await outbox(permanent.outboxId);
    expect(dead).toMatchObject({ status: 'dead', payload_encrypted: null });
    expect(dead.dead_at).toBeInstanceOf(Date);
  });

  it('never auto-retries an ambiguous SMTP acceptance or an expired sending lease', async () => {
    const uncertain = await insertOutbox('uncertain');
    const logSpy = jest.spyOn(Logger.prototype, 'warn');
    send.mockRejectedValueOnce(new MailDeliveryError('SMTP_DELIVERY_UNKNOWN', 'ambiguous', null));
    await service.deliver(uncertain.outboxId);
    expect(await outbox(uncertain.outboxId)).toMatchObject({
      status: 'dead',
      payload_encrypted: null,
      last_error_code: 'SMTP_DELIVERY_UNKNOWN',
    });

    const crash = await insertOutbox('post-accept-crash');
    await AppDataSource.query(
      `UPDATE mail_outbox SET status='sending',claim_token=$2,claimed_at=now()-interval '1 minute',
         lease_expires_at=now()-interval '1 second',attempts=1,last_attempt_at=now()-interval '1 minute',
         next_attempt_at=NULL WHERE id=$1`,
      [crash.outboxId, randomUUID()],
    );
    await service.sweep();
    expect(await outbox(crash.outboxId)).toMatchObject({
      status: 'dead',
      payload_encrypted: null,
      last_error_code: 'SMTP_DELIVERY_UNKNOWN',
    });
    expect(send).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain(uncertain.token);
    expect(logged).not.toContain(`mail-uncertain-${uncertain.inviteId.slice(0, 8)}@example.vn`);
    logSpy.mockRestore();
  });

  it('recovers only a pre-send claim and cancels an inactive credential', async () => {
    const claimed = await insertOutbox('claimed-crash');
    await AppDataSource.query(
      `UPDATE mail_outbox SET status='claimed',claim_token=$2,claimed_at=now()-interval '1 minute',
         lease_expires_at=now()-interval '1 second',attempts=1,last_attempt_at=now()-interval '1 minute',
         next_attempt_at=NULL WHERE id=$1`,
      [claimed.outboxId, randomUUID()],
    );
    const inactive = await insertOutbox('inactive');
    await AppDataSource.query('UPDATE invites SET revoked_at=now() WHERE id=$1', [
      inactive.inviteId,
    ]);
    await service.sweep();
    expect(await outbox(claimed.outboxId)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await outbox(inactive.outboxId)).toMatchObject({
      status: 'cancelled',
      payload_encrypted: null,
      last_error_code: 'MAIL_CREDENTIAL_INVALID',
    });
  });

  it('operator requeue commits safe audit metadata and cancels an inactive credential', async () => {
    const active = await insertOutbox('operator-active');
    await markFailed(active.outboxId);
    const activeResult = await runRequeue(
      active.outboxId,
      'Xác nhận SMTP chưa nhận thư, thử lại có kiểm soát',
    );
    expect(activeResult.stdout).not.toContain(active.token);
    expect(await outbox(active.outboxId)).toMatchObject({ status: 'pending', attempts: 0 });

    const inactive = await insertOutbox('operator-inactive');
    await markFailed(inactive.outboxId);
    await AppDataSource.query('UPDATE invites SET revoked_at=now() WHERE id=$1', [
      inactive.inviteId,
    ]);
    let rejectedOutput = '';
    try {
      await runRequeue(inactive.outboxId, 'Lời mời đã bị thu hồi trước khi vận hành thử lại');
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      rejectedOutput = typeof stderr === 'string' ? stderr : '';
    }
    expect(rejectedOutput).toContain('MAIL_CREDENTIAL_INVALID');
    expect(await outbox(inactive.outboxId)).toMatchObject({
      status: 'cancelled',
      payload_encrypted: null,
    });
    const audits = (await AppDataSource.query(
      `SELECT action,metadata::text AS metadata FROM audit_logs
       WHERE resource_type='mail_outbox' AND resource_id=ANY($1::uuid[])`,
      [[active.outboxId, inactive.outboxId]],
    )) as Array<{ action: string; metadata: string }>;
    expect(audits.map((row) => row.action).sort()).toEqual([
      'mail.outbox_requeue_rejected',
      'mail.outbox_requeued',
    ]);
    expect(JSON.stringify(audits)).not.toContain(active.token);
    expect(JSON.stringify(audits)).not.toContain(inactive.token);
  });

  async function insertOutbox(label: string) {
    const inviteId = randomUUID();
    const outboxId = randomUUID();
    const token = `credential-${randomUUID().replaceAll('-', '')}`;
    inviteIds.push(inviteId);
    ids.push(outboxId);
    await AppDataSource.query(
      `INSERT INTO invites(id,email,username,display_name,role,token_hash,created_by,expires_at)
       VALUES($1,$2,$3,$4,'editor',$5,$6,now()+interval '2 hours')`,
      [
        inviteId,
        `mail-${label}-${inviteId.slice(0, 8)}@example.vn`,
        `mail_${label.replaceAll('-', '_')}_${inviteId.slice(0, 8)}`,
        `Người dùng ${label}`,
        crypto.digest(token),
        adminId,
      ],
    );
    await AppDataSource.query(
      `INSERT INTO mail_outbox(id,template_key,recipient_email,invite_id,payload_encrypted,status,
         attempts,next_attempt_at,correlation_id)
       VALUES($1,'identity.invite',$2,$3,$4,'pending',0,now(),$5)`,
      [
        outboxId,
        `mail-${label}-${inviteId.slice(0, 8)}@example.vn`,
        inviteId,
        crypto.encrypt(JSON.stringify({ inviteId, token })),
        randomUUID(),
      ],
    );
    return { inviteId, outboxId, token };
  }

  async function markFailed(id: string): Promise<void> {
    await AppDataSource.query(
      `UPDATE mail_outbox SET status='failed',next_attempt_at=NULL,failed_at=now(),
         last_error_code='MAIL_SMTP_RECIPIENT_REJECTED' WHERE id=$1`,
      [id],
    );
  }
});

async function outbox(id: string): Promise<Record<string, unknown>> {
  const rows = (await AppDataSource.query('SELECT * FROM mail_outbox WHERE id=$1', [id])) as Array<
    Record<string, unknown>
  >;
  if (!rows[0]) throw new Error('mail outbox fixture missing');
  return rows[0];
}

async function deliveryState(): Promise<Record<string, unknown>> {
  const rows = (await AppDataSource.query('SELECT * FROM mail_delivery_state WHERE id=1')) as Array<
    Record<string, unknown>
  >;
  if (!rows[0]) throw new Error('mail delivery state missing');
  return rows[0];
}

async function runRequeue(outboxId: string, reason: string) {
  return execFileAsync(
    process.execPath,
    [
      './node_modules/tsx/dist/cli.mjs',
      'scripts/requeue-mail.ts',
      '--outbox-id',
      outboxId,
      '--acknowledge-duplicate-risk',
      '--reason',
      reason,
    ],
    { cwd: process.cwd(), env: process.env },
  );
}
