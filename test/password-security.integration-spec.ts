import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import {
  AdminSessionEntity,
  PasswordResetTokenEntity,
  UserEntity,
} from '../src/identity/identity.entities';
import type { IdentityRateLimitService } from '../src/identity/identity-rate-limit.service';
import { PasswordSecurityService } from '../src/identity/password-security.service';

describe('Password and session security transactions', () => {
  const userId = randomUUID();
  const changeKey = randomUUID();
  const revokeKey = randomUUID();
  const resetRequestKey = randomUUID();
  const initialSessionId = randomUUID();
  const suffix = userId.slice(0, 8);
  const currentPassword = 'Temporary-Password-2026!';
  const newPassword = 'Changed-Password-2026!';
  const config = new ConfigService({
    FIELD_ENCRYPTION_KEY: 'password-integration-field-key',
    SESSION_PEPPER: 'password-integration-session-pepper',
  });
  const crypto = new CryptoService(config);
  const enforcePasswordResetRequest = jest.fn<Promise<void>, []>(() => Promise.resolve());

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.getRepository(UserEntity).insert({
      id: userId,
      email: `password-${suffix}@example.gov.vn`,
      emailNormalized: `password-${suffix}@example.gov.vn`,
      username: `password_${suffix}`,
      usernameNormalized: `password_${suffix}`,
      displayName: 'Password integration fixture',
      role: 'editor',
      status: 'active',
      passwordHash: await argon2.hash(currentPassword, { type: argon2.argon2id }),
      mustChangePassword: true,
      mfaEnabled: true,
      mfaSecretEncrypted: null,
      failedLoginCount: 0,
      lockedUntil: null,
      disabledAt: null,
    });
    await AppDataSource.getRepository(AdminSessionEntity).insert({
      id: initialSessionId,
      userId,
      tokenHash: crypto.digest('initial-session-token'),
      csrfHash: crypto.digest('initial-csrf-token'),
      kind: 'authenticated',
      expiresAt: new Date(Date.now() + 60 * 60_000),
      revokedAt: null,
      ipHash: null,
      userAgent: 'integration',
      mfaFailedAttempts: 0,
      mfaLockedUntil: null,
    });
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query('DELETE FROM command_receipts WHERE actor_id=$1', [userId]);
      await manager.query(
        "DELETE FROM public_command_receipts WHERE operation='password.reset.request' AND idempotency_key=$1",
        [resetRequestKey],
      );
      await manager.query('DELETE FROM audit_logs WHERE actor_id=$1 OR resource_id=$1', [userId]);
      await manager.delete(AdminSessionEntity, { userId });
      await manager.delete(PasswordResetTokenEntity, { userId });
      await manager.delete(UserEntity, { id: userId });
      await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
    });
    await AppDataSource.destroy();
  });

  it('changes a password once under concurrency and persists no credential material in receipts', async () => {
    const dto = {
      currentPassword,
      newPassword,
      passwordConfirmation: newPassword,
    };
    const responses = await Promise.all([
      service().changePassword(userId, initialSessionId, 'editor', dto, metadata(), changeKey),
      service().changePassword(userId, initialSessionId, 'editor', dto, metadata(), changeKey),
    ]);
    expect(responses.map((response) => response.owner).sort()).toEqual([false, true]);
    expect(responses[1]?.data).toEqual(responses[0]?.data);
    const owner = responses.find((response) => response.owner)!;
    const replay = responses.find((response) => !response.owner)!;
    expect(owner.sessionToken).toBeDefined();
    expect(owner.csrfToken).toBeDefined();
    expect(replay.sessionToken).toBeUndefined();
    expect(replay.csrfToken).toBeUndefined();

    const persisted = (await AppDataSource.query(
      `SELECT request_digest,response_payload::text AS response
       FROM command_receipts
       WHERE actor_id=$1 AND operation='password.change' AND idempotency_key=$2`,
      [userId, changeKey],
    )) as Array<{ request_digest: string; response: string }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.request_digest).toMatch(/^[a-f0-9]{64}$/);
    const receiptText = JSON.stringify(persisted);
    for (const value of [currentPassword, newPassword, owner.sessionToken, owner.csrfToken]) {
      expect(receiptText).not.toContain(value);
    }
    const sessionCounts = (await AppDataSource.query(
      `SELECT
         count(*) FILTER (WHERE revoked_at IS NULL)::integer AS active,
         count(*) FILTER (WHERE revoked_at IS NOT NULL)::integer AS revoked
       FROM admin_sessions WHERE user_id=$1`,
      [userId],
    )) as Array<{ active: number; revoked: number }>;
    expect(sessionCounts[0]).toEqual({ active: 1, revoked: 1 });

    await expect(
      service().changePassword(
        userId,
        initialSessionId,
        'editor',
        {
          ...dto,
          newPassword: 'Different-Password-2026!',
          passwordConfirmation: 'Different-Password-2026!',
        },
        metadata(),
        changeKey,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('revokes the current session exactly once under concurrent command execution', async () => {
    const rows = (await AppDataSource.query(
      'SELECT id FROM admin_sessions WHERE user_id=$1 AND revoked_at IS NULL',
      [userId],
    )) as Array<{ id: string }>;
    const rotatedSessionId = rows[0]!.id;
    const results = await Promise.all([
      service().revokeAllSessions(userId, rotatedSessionId, 'editor', randomUUID(), revokeKey),
      service().revokeAllSessions(userId, rotatedSessionId, 'editor', randomUUID(), revokeKey),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({
      revokedCount: 1,
      currentSessionRevoked: true,
      loginRequired: true,
    });
    const active = (await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM admin_sessions
       WHERE user_id=$1 AND revoked_at IS NULL`,
      [userId],
    )) as Array<{ count: number }>;
    expect(active[0]?.count).toBe(0);
  });

  it('enforces one active reset token and terminal-state constraints in PostgreSQL', async () => {
    const first = randomUUID();
    await AppDataSource.query(
      `INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '5 minutes')`,
      [first, userId, crypto.digest('constraint-token-one')],
    );
    await expect(
      AppDataSource.query(
        `INSERT INTO password_reset_tokens(user_id,token_hash,expires_at)
         VALUES($1,$2,now()+interval '5 minutes')`,
        [userId, crypto.digest('constraint-token-two')],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await AppDataSource.query('UPDATE password_reset_tokens SET revoked_at=now() WHERE id=$1', [
      first,
    ]);
    await expect(
      AppDataSource.query(
        `INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,used_at,revoked_at)
         VALUES($1,$2,now()+interval '5 minutes',now(),now())`,
        [userId, crypto.digest('constraint-token-terminal')],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('replays a reset-request receipt after service reconstruction without consuming another rate-limit slot', async () => {
    const dto = { email: `missing-${suffix}@example.gov.vn` };
    const first = await service().requestPasswordReset(dto, metadata(), resetRequestKey);
    const replayAfterReconstruction = await service().requestPasswordReset(
      dto,
      metadata(),
      resetRequestKey,
    );

    expect(first).toEqual({ status: 'accepted' });
    expect(replayAfterReconstruction).toEqual(first);
    expect(enforcePasswordResetRequest).toHaveBeenCalledTimes(1);
    await expect(
      service().requestPasswordReset(
        { email: `changed-${suffix}@example.gov.vn` },
        metadata(),
        resetRequestKey,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(enforcePasswordResetRequest).toHaveBeenCalledTimes(1);
  });

  function service(): PasswordSecurityService {
    return new PasswordSecurityService(
      AppDataSource.getRepository(PasswordResetTokenEntity),
      AppDataSource,
      crypto,
      new IdempotencyService(),
      {
        enforcePasswordResetRequest,
        enforcePasswordResetConfirm: () => Promise.resolve(),
      } as unknown as IdentityRateLimitService,
    );
  }

  function metadata() {
    return { requestId: randomUUID(), ip: '127.0.0.1', userAgent: 'integration' };
  }
});
