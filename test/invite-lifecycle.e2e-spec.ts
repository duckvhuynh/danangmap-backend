import { createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import Redis from 'ioredis';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
const allowedOrigin = 'http://localhost:3000';
const seededAdminId = '00000000-0000-4000-8000-000000000001';
const seededMfaSecret = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

jest.setTimeout(90_000);

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
}

interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}

interface Problem {
  status: number;
  code: string;
  message: string;
}

describe('invite inspect and accept HTTP lifecycle', () => {
  const startedAt = new Date();
  const suffix = randomUUID().slice(0, 8);
  const inviteIds: string[] = [];
  const userIds: string[] = [];
  const receiptKeys: string[] = [];
  let adminJar: CookieJar;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=$1',
      [seededAdminId],
    );
    const login = await loginWithPassword(
      'system-admin@danangmap.local',
      process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-2026!',
    );
    const verified = await postWithCsrf('/api/v1/auth/mfa/verify', login.jar, {
      method: 'totp',
      code: generateTotp(seededMfaSecret),
    });
    expect(verified.status).toBe(200);
    login.jar.absorb(verified);
    adminJar = login.jar;
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query(
        `DELETE FROM admin_sessions
         WHERE user_id=ANY($1::uuid[]) OR (user_id=$2 AND created_at >= $3)`,
        [userIds.length ? userIds : [seededAdminId], seededAdminId, startedAt],
      );
      if (receiptKeys.length) {
        await manager.query('DELETE FROM command_receipts WHERE idempotency_key=ANY($1::uuid[])', [
          receiptKeys,
        ]);
      }
      if (inviteIds.length) {
        await manager.query('DELETE FROM mail_outbox WHERE invite_id=ANY($1::uuid[])', [inviteIds]);
        await manager.query(
          `DELETE FROM audit_logs
           WHERE resource_id=ANY($1::uuid[]) OR actor_id=ANY($2::uuid[])`,
          [inviteIds, userIds.length ? userIds : [seededAdminId]],
        );
        await manager.query('DELETE FROM invites WHERE id=ANY($1::uuid[])', [inviteIds]);
      }
      if (userIds.length) {
        await manager.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
      }
      await manager.query(
        `DELETE FROM audit_logs
         WHERE actor_id=$1 AND action LIKE 'auth.%' AND occurred_at >= $2`,
        [seededAdminId, startedAt],
      );
      await manager.query('UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=$1', [
        seededAdminId,
      ]);
      await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
    });
    await AppDataSource.destroy();
    if (process.env.NODE_ENV === 'test') await cleanupIdentityRateKeys();
  });

  it('inspects repeatedly and keeps invalid, expired, revoked and consumed tokens generic', async () => {
    const active = await createInvite('inspect', 'editor');
    const first = await inspectInvite(active.token);
    const second = await inspectInvite(active.token);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as Envelope<{
      maskedEmail: string;
      role: string;
      expiresAt: string;
      requiresMfaEnrollment: boolean;
    }>;
    expect(firstBody.data).toMatchObject({
      role: 'editor',
      requiresMfaEnrollment: true,
    });
    expect(firstBody.data.maskedEmail).not.toContain(active.email);
    expect(firstBody.data.maskedEmail).toContain('@example.gov.vn');
    expect((await second.json()) as Envelope<unknown>).toMatchObject({ data: firstBody.data });

    const expired = await createInvite('expired', 'reviewer');
    await AppDataSource.query(
      "UPDATE invites SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.id],
    );
    const revoked = await createInvite('revoked', 'publisher');
    const revokeKey = randomUUID();
    receiptKeys.push(revokeKey);
    const revokeResponse = await adminCommand(
      `/api/v1/admin/invites/${revoked.id}:revoke`,
      revokeKey,
    );
    expect(revokeResponse.status).toBe(200);
    const replayRevoke = await adminCommand(
      `/api/v1/admin/invites/${revoked.id}:revoke`,
      revokeKey,
    );
    expect(replayRevoke.status).toBe(200);
    const [revokeBody, replayRevokeBody] = await Promise.all([
      revokeResponse.json() as Promise<Envelope<unknown>>,
      replayRevoke.json() as Promise<Envelope<unknown>>,
    ]);
    expect(replayRevokeBody.data).toEqual(revokeBody.data);

    const invalidToken = randomBytes(32).toString('base64url');
    const failures = await Promise.all([
      inspectInvite(expired.token),
      inspectInvite(revoked.token),
      inspectInvite(invalidToken),
    ]);
    const problems = await Promise.all(
      failures.map((response) => readProblem(response, 400, 'INVITE_INVALID_OR_EXPIRED')),
    );
    expect(new Set(problems.map((problem) => problem.message)).size).toBe(1);
    const scrubbed = await decryptInviteOutbox(revoked.id);
    expect(scrubbed).toEqual({ inviteId: revoked.id, status: 'revoked' });
    expect(JSON.stringify(scrubbed)).not.toContain(revoked.token);
  });

  it('accepts exactly once, creates one active user and hands off to mandatory MFA enrollment', async () => {
    const invitation = await createInvite('accept', 'editor');
    const inspectA = await inspectInvite(invitation.token);
    const inspectB = await inspectInvite(invitation.token);
    expect([inspectA.status, inspectB.status]).toEqual([200, 200]);

    const password = 'Accepted-Invite-Password-2026!';
    const publicJar = new CookieJar();
    await rotateCsrf(publicJar);
    const mismatch = await acceptInvite(publicJar, invitation.token, password, `${password}-wrong`);
    await readProblem(mismatch, 422, 'VALIDATION_FAILED');
    const wrongOrigin = await acceptInvite(
      publicJar,
      invitation.token,
      password,
      password,
      'https://attacker.example',
    );
    await readProblem(wrongOrigin, 403, 'CSRF_INVALID');
    const wrongCsrf = await acceptInvite(
      publicJar,
      invitation.token,
      password,
      password,
      allowedOrigin,
      'wrong-token',
    );
    await readProblem(wrongCsrf, 403, 'CSRF_INVALID');

    const acceptedResponses = await Promise.all([
      acceptInvite(publicJar, invitation.token, password, password),
      acceptInvite(publicJar, invitation.token, password, password),
    ]);
    expect(acceptedResponses.map((response) => response.status).sort()).toEqual([200, 400]);
    const acceptedResponse = acceptedResponses.find((response) => response.status === 200)!;
    const rejectedResponse = acceptedResponses.find((response) => response.status === 400)!;
    await readProblem(rejectedResponse, 400, 'INVITE_INVALID_OR_EXPIRED');
    const acceptedJar = new CookieJar();
    acceptedJar.absorb(acceptedResponse);
    expect(acceptedJar.get('__Host-danangmap_preauth')).toBeDefined();
    expect(acceptedJar.get('danangmap_csrf')).toBeDefined();
    const acceptedBody = (await acceptedResponse.json()) as Envelope<{
      status: string;
      mfaEnrollmentRequired: boolean;
      challengeExpiresAt: string;
    }>;
    expect(acceptedBody.data).toMatchObject({
      status: 'mfa_required',
      mfaEnrollmentRequired: true,
    });

    const rows = (await AppDataSource.query(
      `SELECT u.id,u.status,u.role,u.password_hash,u.mfa_enabled,i.used_at,i.accepted_user_id
       FROM invites i JOIN users u ON u.id=i.accepted_user_id WHERE i.id=$1`,
      [invitation.id],
    )) as Array<{
      id: string;
      status: string;
      role: string;
      password_hash: string;
      mfa_enabled: boolean;
      used_at: Date;
      accepted_user_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'active',
      role: 'editor',
      mfa_enabled: false,
    });
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.used_at).toBeInstanceOf(Date);
    expect(rows[0]?.accepted_user_id).toBe(rows[0]?.id);
    userIds.push(rows[0]!.id);

    const immediateEnrollment = await postWithCsrf('/api/v1/auth/mfa/enroll', acceptedJar);
    expect(immediateEnrollment.status).toBe(200);
    const passwordLogin = await loginWithPassword(invitation.email, password);
    expect(passwordLogin.body.data).toMatchObject({ mfaEnrollmentRequired: true });
    const rotatedEnrollment = await postWithCsrf('/api/v1/auth/mfa/enroll', passwordLogin.jar);
    expect(rotatedEnrollment.status).toBe(200);

    const postAcceptInspect = await inspectInvite(invitation.token);
    await readProblem(postAcceptInspect, 400, 'INVITE_INVALID_OR_EXPIRED');
    const replayJar = new CookieJar();
    await rotateCsrf(replayJar);
    const replay = await acceptInvite(replayJar, invitation.token, password, password);
    await readProblem(replay, 400, 'INVITE_INVALID_OR_EXPIRED');

    const scrubbed = await decryptInviteOutbox(invitation.id);
    expect(scrubbed).toEqual({ inviteId: invitation.id, status: 'accepted' });
    const persisted = (await AppDataSource.query(
      `SELECT i.token_hash,o.payload_encrypted,a.metadata::text AS audit_metadata
       FROM invites i
       JOIN mail_outbox o ON o.invite_id=i.id
       LEFT JOIN audit_logs a ON a.resource_id=i.id
       WHERE i.id=$1`,
      [invitation.id],
    )) as Array<{ token_hash: string; payload_encrypted: string; audit_metadata: string | null }>;
    const persistedText = JSON.stringify(persisted);
    expect(persistedText).not.toContain(invitation.token);
    expect(persistedText).not.toContain(password);
  });

  it('fails normalized email and username conflicts atomically without partial users or sessions', async () => {
    const password = 'Conflict-Invite-Password-2026!';
    const emailConflict = await createInvite('email-conflict', 'reviewer');
    const existingEmailUser = await createManualUser(
      emailConflict.email,
      `existing-email-${suffix}`,
    );
    const emailJar = new CookieJar();
    await rotateCsrf(emailJar);
    const emailAccept = await acceptInvite(emailJar, emailConflict.token, password, password);
    await readProblem(emailAccept, 409, 'INVITE_ACCEPTANCE_CONFLICT');

    const usernameConflict = await createInvite('username-conflict', 'publisher');
    const existingUsernameUser = await createManualUser(
      `existing-username-${suffix}@example.gov.vn`,
      usernameConflict.username,
    );
    const usernameJar = new CookieJar();
    await rotateCsrf(usernameJar);
    const usernameAccept = await acceptInvite(
      usernameJar,
      usernameConflict.token,
      password,
      password,
    );
    await readProblem(usernameAccept, 409, 'INVITE_ACCEPTANCE_CONFLICT');

    const states = (await AppDataSource.query(
      `SELECT id,used_at,accepted_user_id FROM invites WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[emailConflict.id, usernameConflict.id]],
    )) as Array<{ id: string; used_at: Date | null; accepted_user_id: string | null }>;
    expect(states).toHaveLength(2);
    expect(states.every((state) => state.used_at === null && state.accepted_user_id === null)).toBe(
      true,
    );
    const partialUsers = (await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM users
       WHERE username_normalized=$1 OR email_normalized=$2`,
      [emailConflict.username, usernameConflict.email],
    )) as Array<{ count: number }>;
    expect(partialUsers[0]?.count).toBe(0);
    const sessions = (await AppDataSource.query(
      'SELECT count(*)::integer AS count FROM admin_sessions WHERE user_id=ANY($1::uuid[])',
      [[existingEmailUser, existingUsernameUser]],
    )) as Array<{ count: number }>;
    expect(sessions[0]?.count).toBe(0);
  });

  it('rate limits repeated public token guesses before unbounded Argon2 work', async () => {
    const inspectToken = randomBytes(32).toString('base64url');
    const inspectResponses = await Promise.all(
      Array.from({ length: 31 }, () => inspectInvite(inspectToken)),
    );
    expect(inspectResponses.filter((response) => response.status === 400)).toHaveLength(30);
    const limitedInspect = inspectResponses.find((response) => response.status === 429)!;
    expect(limitedInspect.headers.get('retry-after')).toMatch(/^\d+$/);
    await readProblem(limitedInspect, 429, 'RATE_LIMITED');

    const acceptToken = randomBytes(32).toString('base64url');
    const publicJar = new CookieJar();
    await rotateCsrf(publicJar);
    const attempts: Response[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      attempts.push(
        await acceptInvite(
          publicJar,
          acceptToken,
          'Rate-Limit-Password-2026!',
          'Rate-Limit-Password-2026!',
        ),
      );
    }
    expect(attempts.slice(0, 5).every((response) => response.status === 400)).toBe(true);
    expect(attempts[5]?.status).toBe(429);
    expect(attempts[5]?.headers.get('retry-after')).toMatch(/^\d+$/);
    await readProblem(attempts[5]!, 429, 'RATE_LIMITED');
  });

  async function createInvite(label: string, role: 'editor' | 'reviewer' | 'publisher') {
    const idempotencyKey = randomUUID();
    receiptKeys.push(idempotencyKey);
    const email = `invite-e2e-${label}-${suffix}@example.gov.vn`;
    const username = `invite-${label}-${suffix}`;
    const response = await fetch(`${apiBaseUrl}/api/v1/admin/invites`, {
      method: 'POST',
      headers: adminHeaders(idempotencyKey),
      body: JSON.stringify({
        email,
        username,
        displayName: `Invite ${label}`,
        role,
        expiresInHours: 24,
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as Envelope<{ id: string }>;
    inviteIds.push(body.data.id);
    return {
      id: body.data.id,
      email,
      username,
      token: await captureInviteToken(body.data.id),
    };
  }

  async function createManualUser(email: string, username: string): Promise<string> {
    const idempotencyKey = randomUUID();
    receiptKeys.push(idempotencyKey);
    const response = await fetch(`${apiBaseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders(idempotencyKey),
      body: JSON.stringify({
        email,
        username,
        displayName: 'Invite conflict fixture',
        role: 'editor',
        delivery: 'manual',
        temporaryPassword: 'Temporary-Conflict-Password-2026!',
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Envelope<{ id: string }>;
    userIds.push(body.data.id);
    return body.data.id;
  }

  function adminHeaders(idempotencyKey: string): Record<string, string> {
    return {
      ...jsonHeaders(adminJar, adminJar.get('danangmap_csrf'), allowedOrigin),
      'Idempotency-Key': idempotencyKey,
    };
  }

  async function adminCommand(path: string, idempotencyKey: string): Promise<Response> {
    return fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: adminHeaders(idempotencyKey),
    });
  }
});

async function inspectInvite(token: string): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/v1/auth/invites:inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function acceptInvite(
  jar: CookieJar,
  token: string,
  password: string,
  passwordConfirmation: string,
  origin = allowedOrigin,
  overrideCsrf?: string,
): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/v1/auth/invites:accept`, {
    method: 'POST',
    headers: jsonHeaders(jar, overrideCsrf ?? jar.get('danangmap_csrf'), origin),
    body: JSON.stringify({ token, password, passwordConfirmation }),
  });
}

async function captureInviteToken(inviteId: string): Promise<string> {
  const payload = await decryptInviteOutbox(inviteId);
  const token = payload.token;
  if (typeof token !== 'string') throw new Error('Invite mail capture did not contain a token');
  return token;
}

async function decryptInviteOutbox(inviteId: string): Promise<Record<string, unknown>> {
  const rows = (await AppDataSource.query(
    `SELECT payload_encrypted FROM mail_outbox WHERE invite_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [inviteId],
  )) as Array<{ payload_encrypted: string }>;
  const encrypted = rows[0]?.payload_encrypted;
  if (!encrypted) throw new Error('Invite mail capture was not found');
  return JSON.parse(decryptField(encrypted)) as Record<string, unknown>;
}

function decryptField(payload: string): string {
  const [nonce, tag, encrypted] = payload.split('.');
  if (!nonce || !tag || !encrypted) throw new Error('Encrypted capture is malformed');
  const key = createHash('sha256')
    .update(
      process.env.FIELD_ENCRYPTION_KEY ?? 'local-only-field-encryption-key-change-in-production',
    )
    .digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

async function rotateCsrf(jar: CookieJar): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: jar.header() ? { Cookie: jar.header() } : undefined,
  });
  expect(response.status).toBe(200);
  jar.absorb(response);
  const body = (await response.json()) as Envelope<{ csrfToken: string }>;
  return body.data.csrfToken;
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

function jsonHeaders(jar: CookieJar, csrf?: string, origin?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(jar.header() ? { Cookie: jar.header() } : {}),
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    ...(origin ? { Origin: origin } : {}),
  };
}

async function readProblem(response: Response, status: number, code: string): Promise<Problem> {
  expect(response.status).toBe(status);
  const problem = (await response.json()) as Problem;
  expect(problem).toMatchObject({ status, code });
  return problem;
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
