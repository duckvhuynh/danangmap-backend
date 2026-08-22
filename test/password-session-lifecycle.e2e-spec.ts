import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import AppDataSource from '../src/database/data-source';
import { waitForMailpitMessage } from './mailpit.helper';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
const allowedOrigin = 'http://localhost:3000';
const seededAdminId = '00000000-0000-4000-8000-000000000001';
const seededMfaSecret = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

jest.setTimeout(120_000);

class CookieJar {
  private readonly values = new Map<string, string>();

  absorb(response: Response): void {
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator < 1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue.length === 0 || /max-age=0/i.test(value)) this.values.delete(name);
      else this.values.set(name, cookieValue);
    }
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  header(): string {
    return [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  clone(): CookieJar {
    const clone = new CookieJar();
    for (const [name, value] of this.values) clone.values.set(name, value);
    return clone;
  }
}

interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}

describe('password reset, change and session-revocation HTTP lifecycle', () => {
  const startedAt = new Date();
  const suffix = randomUUID().slice(0, 8);
  const login = `password-e2e-${suffix}@example.gov.vn`;
  const username = `password_e2e_${suffix}`;
  const temporaryPassword = 'Temporary-Password-E2E-2026!';
  const changedPassword = 'Changed-Password-E2E-2026!';
  const resetPassword = 'Reset-Password-E2E-2026!';
  const commandKeys: string[] = [];
  const publicKeys: string[] = [];
  let userId = '';
  let adminJar: CookieJar;
  let recoveryCodes: string[] = [];

  beforeAll(async () => {
    await cleanupIdentityRateKeys();
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=$1',
      [seededAdminId],
    );
    const adminLogin = await loginWithPassword(
      'system-admin@danangmap.local',
      process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-2026!',
    );
    const verified = await postWithCsrf('/api/v1/auth/mfa/verify', adminLogin.jar, {
      method: 'totp',
      code: generateTotp(seededMfaSecret),
    });
    expect(verified.status).toBe(200);
    adminLogin.jar.absorb(verified);
    adminJar = adminLogin.jar;

    const createKey = randomUUID();
    commandKeys.push(createKey);
    const created = await fetch(`${apiBaseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: commandHeaders(adminJar, createKey),
      body: JSON.stringify({
        email: login,
        username,
        displayName: 'Password lifecycle fixture',
        role: 'editor',
        delivery: 'manual',
        temporaryPassword,
      }),
    });
    expect(created.status).toBe(201);
    userId = ((await created.json()) as Envelope<{ id: string }>).data.id;
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
        await manager.query(
          'DELETE FROM mail_outbox WHERE password_reset_token_id IN (SELECT id FROM password_reset_tokens WHERE user_id=$1)',
          [userId],
        );
        if (publicKeys.length) {
          await manager.query(
            'DELETE FROM public_command_receipts WHERE idempotency_key=ANY($1::uuid[])',
            [publicKeys],
          );
        }
        await manager.query('DELETE FROM command_receipts WHERE actor_id=$1', [userId]);
        if (commandKeys.length) {
          await manager.query(
            'DELETE FROM command_receipts WHERE idempotency_key=ANY($1::uuid[])',
            [commandKeys],
          );
        }
        await manager.query(
          `DELETE FROM audit_logs
           WHERE resource_id=$1 OR actor_id=$1
              OR (actor_id=$2 AND occurred_at >= $3 AND action LIKE 'identity.user.%')`,
          [userId, seededAdminId, startedAt],
        );
        await manager.query('DELETE FROM admin_sessions WHERE user_id=$1', [userId]);
        await manager.query('DELETE FROM users WHERE id=$1', [userId]);
        await manager.query(`DELETE FROM admin_sessions WHERE user_id=$1 AND created_at >= $2`, [
          seededAdminId,
          startedAt,
        ]);
        await manager.query(
          'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=$1',
          [seededAdminId],
        );
        await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
      });
      await AppDataSource.destroy();
    }
    await cleanupIdentityRateKeys();
  });

  it('forces change, resets safely and revokes every session', async () => {
    const enrollment = await loginWithPassword(login, temporaryPassword);
    expect(enrollment.body.data.mfaEnrollmentRequired).toBe(true);
    const start = await postWithCsrf('/api/v1/auth/mfa/enroll', enrollment.jar);
    expect(start.status).toBe(200);
    const enrollmentUri = ((await start.json()) as Envelope<{ enrollmentUri: string }>).data
      .enrollmentUri;
    const secret = new URL(enrollmentUri).searchParams.get('secret');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const confirmed = await postWithCsrf('/api/v1/auth/mfa/enroll/confirm', enrollment.jar, {
      code: generateTotp(secret!),
    });
    expect(confirmed.status).toBe(200);
    enrollment.jar.absorb(confirmed);
    recoveryCodes = ((await confirmed.json()) as Envelope<{ recoveryCodes: string[] }>).data
      .recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    const restricted = await fetch(`${apiBaseUrl}/api/v1/admin/layers`, {
      headers: { Cookie: enrollment.jar.header() },
    });
    await expectProblem(restricted, 403, 'PASSWORD_CHANGE_REQUIRED');

    const secondLogin = await loginWithPassword(login, temporaryPassword);
    const secondVerified = await postWithCsrf('/api/v1/auth/mfa/verify', secondLogin.jar, {
      method: 'recovery_code',
      code: recoveryCodes[0],
    });
    expect(secondVerified.status).toBe(200);
    secondLogin.jar.absorb(secondVerified);

    const changeBody = {
      currentPassword: temporaryPassword,
      newPassword: changedPassword,
      passwordConfirmation: changedPassword,
    };
    const noOrigin = await passwordChange(enrollment.jar, randomUUID(), changeBody, undefined);
    await expectProblem(noOrigin, 403, 'CSRF_INVALID');
    const wrongCsrf = await passwordChange(
      enrollment.jar,
      randomUUID(),
      changeBody,
      allowedOrigin,
      'wrong-token',
    );
    await expectProblem(wrongCsrf, 403, 'CSRF_INVALID');
    const missingKey = await passwordChange(enrollment.jar, undefined, changeBody, allowedOrigin);
    await expectProblem(missingKey, 428, 'IDEMPOTENCY_KEY_REQUIRED');
    const wrongPassword = await passwordChange(
      enrollment.jar,
      randomUUID(),
      { ...changeBody, currentPassword: 'Wrong-Password-2026!' },
      allowedOrigin,
    );
    await expectProblem(wrongPassword, 401, 'AUTH_INVALID_CREDENTIALS');

    const changeKey = randomUUID();
    commandKeys.push(changeKey);
    const changeResponses = await Promise.all([
      passwordChange(enrollment.jar, changeKey, changeBody, allowedOrigin),
      passwordChange(enrollment.jar, changeKey, changeBody, allowedOrigin),
    ]);
    expect(changeResponses.map((response) => response.status)).toEqual([200, 200]);
    const changePayloads = await Promise.all(
      changeResponses.map((response) => response.clone().json() as Promise<Envelope<unknown>>),
    );
    expect(changePayloads[1]?.data).toEqual(changePayloads[0]?.data);
    const cookieOwners = changeResponses.filter((response) =>
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith('__Host-danangmap_session=')),
    );
    expect(cookieOwners).toHaveLength(1);
    const rotatedJar = enrollment.jar.clone();
    rotatedJar.absorb(cookieOwners[0]!);
    expect(
      (changePayloads[0] as Envelope<{ principal: { mustChangePassword: boolean } }>).data.principal
        .mustChangePassword,
    ).toBe(false);
    await expectUnauthorizedMe(enrollment.jar);
    await expectUnauthorizedMe(secondLogin.jar);
    expect((await getMe(rotatedJar)).status).toBe(200);

    const missingResetKey = await requestReset(login, undefined);
    await expectProblem(missingResetKey.response, 428, 'IDEMPOTENCY_KEY_REQUIRED');
    const unknownKey = randomUUID();
    publicKeys.push(unknownKey);
    const unknown = await requestReset(`unknown-${suffix}@example.gov.vn`, unknownKey);
    expect(unknown.response.status).toBe(202);
    expect(unknown.elapsedMs).toBeGreaterThanOrEqual(130);
    const changedUnknown = await requestReset(`different-${suffix}@example.gov.vn`, unknownKey);
    await expectProblem(changedUnknown.response, 409, 'IDEMPOTENCY_KEY_REUSED');

    const firstResetKey = randomUUID();
    publicKeys.push(firstResetKey);
    const firstReset = await requestReset(login, firstResetKey);
    expect(firstReset.response.status).toBe(202);
    expect(firstReset.elapsedMs).toBeGreaterThanOrEqual(130);
    expect(Math.abs(firstReset.elapsedMs - unknown.elapsedMs)).toBeLessThan(800);
    const firstDelivery = await waitForMailpitMessage(login, 1);
    expect(firstDelivery.subject).toContain('đặt lại mật khẩu');
    expect(firstDelivery.text).toContain('sao chép và dán');
    expect(firstDelivery.text).not.toMatch(/https?:\/\//i);
    const firstToken = {
      id: await latestResetTokenId(userId),
      token: firstDelivery.code,
    };
    expect(await waitForResetOutboxStatus(firstToken.id, 'sent')).toMatchObject({
      status: 'sent',
      payload_encrypted: null,
    });
    const resetReplay = await requestReset(login, firstResetKey);
    expect(resetReplay.response.status).toBe(202);
    const outboxAfterReplay = await resetOutboxCount(userId);
    expect(outboxAfterReplay).toBe(1);
    expect((await waitForMailpitMessage(login, 1)).messageId).toBe(firstDelivery.messageId);

    const secondResetKey = randomUUID();
    publicKeys.push(secondResetKey);
    const secondReset = await requestReset(login, secondResetKey);
    expect(secondReset.response.status).toBe(202);
    const secondDelivery = await waitForMailpitMessage(login, 2);
    const secondToken = {
      id: await latestResetTokenId(userId),
      token: secondDelivery.code,
    };
    expect(secondToken.id).not.toBe(firstToken.id);

    const publicJar = new CookieJar();
    await rotateCsrf(publicJar);
    await expectGenericResetFailure(await confirmReset(publicJar, firstToken.token, resetPassword));
    await AppDataSource.query(
      "UPDATE password_reset_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
      [secondToken.id],
    );
    await expectGenericResetFailure(
      await confirmReset(publicJar, secondToken.token, resetPassword),
    );
    await AppDataSource.query(
      "UPDATE password_reset_tokens SET expires_at=now()+interval '5 minutes' WHERE id=$1",
      [secondToken.id],
    );
    await expectGenericResetFailure(
      await confirmReset(publicJar, randomBytes(32).toString('base64url'), resetPassword),
    );
    const wrongOriginConfirm = await confirmReset(
      publicJar,
      secondToken.token,
      resetPassword,
      'https://attacker.example',
    );
    await expectProblem(wrongOriginConfirm, 403, 'CSRF_INVALID');
    const wrongCsrfConfirm = await confirmReset(
      publicJar,
      secondToken.token,
      resetPassword,
      allowedOrigin,
      'wrong-token',
    );
    await expectProblem(wrongCsrfConfirm, 403, 'CSRF_INVALID');

    const pendingPreauth = await loginWithPassword(login, changedPassword);
    const resetResults = await Promise.all([
      confirmReset(publicJar, secondToken.token, resetPassword),
      confirmReset(publicJar, secondToken.token, resetPassword),
    ]);
    expect(resetResults.map((response) => response.status).sort()).toEqual([200, 400]);
    const resetSuccess = resetResults.find((response) => response.status === 200)!;
    expect((await resetSuccess.json()) as Envelope<unknown>).toMatchObject({
      data: { status: 'password_reset', loginRequired: true },
    });
    expect(
      resetSuccess.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith('__Host-danangmap_session=;')),
    ).toBe(true);
    await expectUnauthorizedMe(rotatedJar);
    const preauthVerify = await postWithCsrf('/api/v1/auth/mfa/verify', pendingPreauth.jar, {
      method: 'recovery_code',
      code: recoveryCodes[1],
    });
    expect(preauthVerify.status).toBe(401);
    expect(await resetOutboxState(secondToken.id)).toMatchObject({
      status: 'sent',
      payload_encrypted: null,
    });

    const sessionA = await authenticatedLoginWithRecovery(resetPassword, recoveryCodes[2]!);
    const sessionB = await authenticatedLoginWithRecovery(resetPassword, recoveryCodes[3]!);
    const revokeMissingKey = await revokeAll(sessionA, undefined);
    await expectProblem(revokeMissingKey, 428, 'IDEMPOTENCY_KEY_REQUIRED');
    const revokeKey = randomUUID();
    commandKeys.push(revokeKey);
    const revoked = await revokeAll(sessionA, revokeKey);
    expect(revoked.status).toBe(200);
    expect((await revoked.json()) as Envelope<unknown>).toMatchObject({
      data: {
        currentSessionRevoked: true,
        loginRequired: true,
        revokedCount: 2,
      },
    });
    expect(
      revoked.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith('__Host-danangmap_session=;')),
    ).toBe(true);
    await expectUnauthorizedMe(sessionA);
    await expectUnauthorizedMe(sessionB);
    const sequentialReplay = await revokeAll(sessionA, revokeKey);
    expect(sequentialReplay.status).toBe(401);

    const persistedRows = (await AppDataSource.query(
      `SELECT
         (SELECT jsonb_agg(metadata) FROM audit_logs WHERE resource_id=$1 OR actor_id=$1) AS audits,
         (SELECT jsonb_agg(response_payload) FROM command_receipts WHERE actor_id=$1) AS receipts,
         (SELECT jsonb_agg(response_payload) FROM public_command_receipts WHERE idempotency_key=ANY($2::uuid[])) AS public_receipts`,
      [userId, publicKeys],
    )) as Array<Record<string, unknown>>;
    const persistedText = JSON.stringify(persistedRows);
    for (const secretValue of [
      temporaryPassword,
      changedPassword,
      resetPassword,
      firstToken.token,
      secondToken.token,
      ...recoveryCodes,
    ]) {
      expect(persistedText).not.toContain(secretValue);
    }
    const resetAudit = (await AppDataSource.query(
      `SELECT actor_id,actor_role,resource_id FROM audit_logs
       WHERE action='auth.password_reset_completed' AND resource_id=$1`,
      [userId],
    )) as Array<{ actor_id: string | null; actor_role: string | null; resource_id: string }>;
    expect(resetAudit).toEqual([{ actor_id: null, actor_role: null, resource_id: userId }]);
  });

  it('rate limits enumeration-safe reset requests with Retry-After', async () => {
    const attempts: Response[] = [];
    const target = `limited-${suffix}@example.gov.vn`;
    for (let index = 0; index < 4; index += 1) {
      const key = randomUUID();
      publicKeys.push(key);
      attempts.push((await requestReset(target, key)).response);
    }
    expect(attempts.slice(0, 3).every((response) => response.status === 202)).toBe(true);
    expect(attempts[3]?.status).toBe(429);
    expect(attempts[3]?.headers.get('retry-after')).toMatch(/^\d+$/);
    await expectProblem(attempts[3]!, 429, 'RATE_LIMITED');
  });

  it('rate limits reset-token guesses before unbounded Argon2 work', async () => {
    const publicJar = new CookieJar();
    await rotateCsrf(publicJar);
    const token = randomBytes(32).toString('base64url');
    const attempts: Response[] = [];
    for (let index = 0; index < 6; index += 1) {
      attempts.push(await confirmReset(publicJar, token, 'Guess-Resistance-Password-2026!'));
    }
    expect(attempts.slice(0, 5).every((response) => response.status === 400)).toBe(true);
    expect(attempts[5]?.status).toBe(429);
    expect(attempts[5]?.headers.get('retry-after')).toMatch(/^\d+$/);
    await expectProblem(attempts[5]!, 429, 'RATE_LIMITED');
  });

  async function authenticatedLoginWithRecovery(password: string, recoveryCode: string) {
    const result = await loginWithPassword(login, password);
    const verified = await postWithCsrf('/api/v1/auth/mfa/verify', result.jar, {
      method: 'recovery_code',
      code: recoveryCode,
    });
    expect(verified.status).toBe(200);
    result.jar.absorb(verified);
    return result.jar;
  }
});

async function passwordChange(
  jar: CookieJar,
  key: string | undefined,
  body: Record<string, unknown>,
  origin: string | undefined,
  overrideCsrf?: string,
): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/v1/auth/password/change`, {
    method: 'POST',
    headers: {
      ...jsonHeaders(jar, overrideCsrf ?? jar.get('danangmap_csrf'), origin),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function requestReset(email: string, key: string | undefined) {
  const startedAt = Date.now();
  const response = await fetch(`${apiBaseUrl}/api/v1/auth/password/reset:request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify({ email }),
  });
  return { response, elapsedMs: Date.now() - startedAt };
}

async function confirmReset(
  jar: CookieJar,
  token: string,
  password: string,
  origin = allowedOrigin,
  overrideCsrf?: string,
): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/v1/auth/password/reset:confirm`, {
    method: 'POST',
    headers: jsonHeaders(jar, overrideCsrf ?? jar.get('danangmap_csrf'), origin),
    body: JSON.stringify({ token, password, passwordConfirmation: password }),
  });
}

async function revokeAll(jar: CookieJar, key: string | undefined): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/v1/auth/sessions:revoke-all`, {
    method: 'POST',
    headers: {
      ...jsonHeaders(jar, jar.get('danangmap_csrf'), allowedOrigin),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
  });
}

async function latestResetTokenId(userId: string): Promise<string> {
  const rows = (await AppDataSource.query(
    `SELECT t.id
     FROM password_reset_tokens t JOIN mail_outbox o ON o.password_reset_token_id=t.id
     WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT 1`,
    [userId],
  )) as Array<{ id: string }>;
  const row = rows[0];
  if (!row) throw new Error('Password reset outbox was not found');
  return row.id;
}

async function resetOutboxState(resetTokenId: string): Promise<Record<string, unknown>> {
  const rows = (await AppDataSource.query(
    `SELECT status,payload_encrypted,payload_scrubbed_at,last_error_code FROM mail_outbox
     WHERE password_reset_token_id=$1`,
    [resetTokenId],
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error('Password reset outbox was not found');
  return row;
}

async function waitForResetOutboxStatus(
  resetTokenId: string,
  status: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = await resetOutboxState(resetTokenId);
    if (row.status === status) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Password-reset mail outbox did not reach ${status}`);
}

async function resetOutboxCount(userId: string): Promise<number> {
  const rows = (await AppDataSource.query(
    `SELECT count(*)::integer AS count FROM mail_outbox o
     JOIN password_reset_tokens t ON t.id=o.password_reset_token_id WHERE t.user_id=$1`,
    [userId],
  )) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

async function rotateCsrf(jar: CookieJar): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: jar.header() ? { Cookie: jar.header() } : undefined,
  });
  expect(response.status).toBe(200);
  jar.absorb(response);
  return ((await response.json()) as Envelope<{ csrfToken: string }>).data.csrfToken;
}

async function loginWithPassword(login: string, password: string) {
  const jar = new CookieJar();
  const csrf = await rotateCsrf(jar);
  const response = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: jsonHeaders(jar, csrf, allowedOrigin),
    body: JSON.stringify({ login, password }),
  });
  expect(response.status).toBe(200);
  jar.absorb(response);
  const body = (await response.json()) as Envelope<{
    status: string;
    mfaEnrollmentRequired: boolean;
  }>;
  return { jar, body };
}

async function postWithCsrf(
  path: string,
  jar: CookieJar,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: jsonHeaders(jar, jar.get('danangmap_csrf'), allowedOrigin),
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function getMe(jar: CookieJar): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/v1/auth/me`, { headers: { Cookie: jar.header() } });
}

async function expectUnauthorizedMe(jar: CookieJar): Promise<void> {
  expect((await getMe(jar)).status).toBe(401);
}

function commandHeaders(jar: CookieJar, key: string): Record<string, string> {
  return {
    ...jsonHeaders(jar, jar.get('danangmap_csrf'), allowedOrigin),
    'Idempotency-Key': key,
  };
}

function jsonHeaders(jar: CookieJar, csrf?: string, origin?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(jar.header() ? { Cookie: jar.header() } : {}),
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    ...(origin ? { Origin: origin } : {}),
  };
}

async function expectProblem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.clone().json()).resolves.toMatchObject({ status, code });
}

async function expectGenericResetFailure(response: Response): Promise<void> {
  await expectProblem(response, 400, 'PASSWORD_RESET_INVALID_OR_EXPIRED');
}

function generateTotp(secret: string, epochSeconds = Math.floor(Date.now() / 1_000)): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replaceAll('=', '').toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error('Invalid Base32 secret');
    bits += value.toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epochSeconds / 30)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

async function cleanupIdentityRateKeys(): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 1,
  });
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        '{identity-rate}:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length) await redis.unlink(...keys);
    } while (cursor !== '0');
  } finally {
    await redis.quit();
  }
}
