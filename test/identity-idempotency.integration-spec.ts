import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../src/audit/audit.service';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { AppException } from '../src/common/http/app.exception';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import { AuthService } from '../src/identity/auth.service';
import {
  AdminSessionEntity,
  AuditLogEntity,
  InviteEntity,
  MailOutboxEntity,
  UserEntity,
} from '../src/identity/identity.entities';

jest.mock('otplib', () => ({ verify: jest.fn() }));

describe('Identity command idempotency', () => {
  const adminId = '00000000-0000-4000-8000-000000000001';
  const key = randomUUID();
  const alternateKeys = [randomUUID(), randomUUID()];
  const suffix = key.slice(0, 8);
  const dto = {
    email: `invite-${suffix}@example.gov.vn`,
    username: `invite_${suffix}`,
    displayName: 'Invite receipt fixture',
    role: 'reviewer' as const,
    expiresInHours: 72,
  };
  const config = new ConfigService({
    FIELD_ENCRYPTION_KEY: 'integration-field-key',
    SESSION_PEPPER: 'integration-session-pepper',
  });
  const crypto = new CryptoService(config);
  let inviteId: string | undefined;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
        await manager.query(
          `DELETE FROM command_receipts
           WHERE actor_id=$1 AND operation='invite.create' AND idempotency_key=ANY($2::uuid[])`,
          [adminId, [key, ...alternateKeys]],
        );
        await manager.delete(MailOutboxEntity, { recipientEmail: dto.email });
        await manager.delete(InviteEntity, { email: dto.email });
        if (inviteId) await manager.delete(AuditLogEntity, { resourceId: inviteId });
        await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
      });
      await AppDataSource.destroy();
    }
  });

  it('creates one invite/outbox row under concurrency and replays after restart', async () => {
    const service = createAuthService();
    const results = await Promise.all([
      service.createInvite(dto, adminId, 'system_admin', randomUUID(), key),
      service.createInvite(dto, adminId, 'system_admin', randomUUID(), key),
    ]);
    expect(results[1]).toEqual(results[0]);
    inviteId = String(results[0].id);
    await expect(
      createAuthService().createInvite(dto, adminId, 'system_admin', randomUUID(), key),
    ).resolves.toEqual(results[0]);
    const rows = (await AppDataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM invites WHERE email=$1) AS invites,
         (SELECT count(*)::integer FROM mail_outbox WHERE recipient_email=$1) AS outbox`,
      [dto.email],
    )) as Array<{ invites: number; outbox: number }>;
    expect(rows[0]).toEqual({ invites: 1, outbox: 1 });

    const crossKeyReplay = await Promise.all(
      alternateKeys.map((alternateKey) =>
        createAuthService().createInvite(
          dto,
          adminId,
          'system_admin',
          randomUUID(),
          alternateKey,
        ),
      ),
    );
    expect(crossKeyReplay.map((result) => result.id)).toEqual([inviteId, inviteId]);
    const crossKeyCounts = (await AppDataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM invites WHERE email=$1) AS invites,
         (SELECT count(*)::integer FROM mail_outbox WHERE recipient_email=$1) AS outbox`,
      [dto.email],
    )) as Array<{ invites: number; outbox: number }>;
    expect(crossKeyCounts[0]).toEqual({ invites: 1, outbox: 1 });

    try {
      await createAuthService().createInvite(
        { ...dto, displayName: 'Changed' },
        adminId,
        'system_admin',
        randomUUID(),
        key,
      );
      throw new Error('Expected idempotency conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    }
  });

  function createAuthService() {
    return new AuthService(
      AppDataSource.getRepository(UserEntity),
      AppDataSource.getRepository(AdminSessionEntity),
      AppDataSource.getRepository(InviteEntity),
      AppDataSource.getRepository(MailOutboxEntity),
      crypto,
      new AuditService(AppDataSource.getRepository(AuditLogEntity)),
      config,
      AppDataSource,
      new IdempotencyService(),
    );
  }
});
