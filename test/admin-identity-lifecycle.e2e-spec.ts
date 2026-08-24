import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import { waitForMailpitMessage } from './mailpit.helper';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
const allowedOrigin = 'http://localhost:3000';
const seededAdminId = '00000000-0000-4000-8000-000000000001';
const seededMfaSecret = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

jest.setTimeout(120_000);

class CookieJar {
  private readonly values = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    for (const [name, value] of Object.entries(initial ?? {})) this.values.set(name, value);
  }

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
  meta: { requestId: string; nextCursor?: string | null; hasMore?: boolean; limit?: number };
}

interface UserDetail {
  id: string;
  displayName: string;
  role: string;
  status: string;
  etag: string;
  lockVersion: number;
  mfa: { enabled: boolean; recoveryCodesRemaining: number };
  sessions: Array<{ id: string; status: string; userAgent: string | null }>;
  passwordResets: Array<{ id: string; status: string; mailStatus: string | null }>;
}

describe('System Admin identity lifecycle HTTP API', () => {
  const startedAt = new Date();
  const suffix = randomUUID().slice(0, 8);
  const targetEmail = `admin-lifecycle-${suffix}@example.gov.vn`;
  const targetUsername = `admin-lifecycle-${suffix}`;
  const inviteEmail = `admin-invite-${suffix}@example.gov.vn`;
  const idempotencyKeys: string[] = [];
  const targetSessionTokens = new Map<string, string>();
  let adminJar: CookieJar;
  let targetUserId = '';
  let targetEtag = '';

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=$1',
      [seededAdminId],
    );
    adminJar = await loginAdmin();
    const createKey = key();
    const created = await adminRequest('/api/v1/admin/users', {
      method: 'POST',
      key: createKey,
      body: {
        email: targetEmail,
        username: targetUsername,
        displayName: 'Tài khoản lifecycle',
        role: 'editor',
        delivery: 'manual',
        temporaryPassword: 'Admin-Lifecycle-Password-2026!',
      },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Envelope<{ id: string }>;
    targetUserId = createdBody.data.id;
    await AppDataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE users SET must_change_password=false,mfa_enabled=true,
                mfa_secret_encrypted='e2e-secret-never-returned',updated_at=now()
         WHERE id=$1`,
        [targetUserId],
      );
      await manager.query(
        `INSERT INTO user_mfa_methods(
           user_id,status,secret_encrypted,last_used_time_step,enrollment_session_id,verified_at
         ) VALUES($1,'verified','e2e-secret-never-returned',NULL,NULL,now())`,
        [targetUserId],
      );
      await manager.query(
        `INSERT INTO user_mfa_recovery_codes(user_id,code_digest)
         VALUES($1,$2),($1,$3)`,
        [targetUserId, digest(`recovery-a-${suffix}`), digest(`recovery-b-${suffix}`)],
      );
    });
    const targetSession = await createSession(targetUserId, 'target-browser-primary');
    targetSessionTokens.set(targetSession.id, targetSession.token);
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query(
        `DELETE FROM command_receipts
         WHERE idempotency_key=ANY($1::uuid[])`,
        [idempotencyKeys.length ? idempotencyKeys : [randomUUID()]],
      );
      const resetIds = (await manager.query(
        'SELECT id FROM password_reset_tokens WHERE user_id=$1',
        [targetUserId || seededAdminId],
      )) as Array<{ id: string }>;
      if (resetIds.length) {
        await manager.query(
          'DELETE FROM mail_outbox WHERE password_reset_token_id=ANY($1::uuid[])',
          [resetIds.map((row) => row.id)],
        );
      }
      await manager.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [
        targetUserId || seededAdminId,
      ]);
      const inviteIds = (await manager.query(
        'SELECT id FROM invites WHERE lower(email)=lower($1)',
        [inviteEmail],
      )) as Array<{ id: string }>;
      if (inviteIds.length) {
        await manager.query('DELETE FROM mail_outbox WHERE invite_id=ANY($1::uuid[])', [
          inviteIds.map((row) => row.id),
        ]);
        await manager.query('DELETE FROM invites WHERE id=ANY($1::uuid[])', [
          inviteIds.map((row) => row.id),
        ]);
      }
      if (targetUserId) {
        await manager.query('DELETE FROM admin_sessions WHERE user_id=$1', [targetUserId]);
        await manager.query('DELETE FROM user_mfa_recovery_codes WHERE user_id=$1', [targetUserId]);
        await manager.query('DELETE FROM user_mfa_methods WHERE user_id=$1', [targetUserId]);
        await manager.query('DELETE FROM audit_logs WHERE resource_id=$1 OR actor_id=$1', [
          targetUserId,
        ]);
        await manager.query('DELETE FROM users WHERE id=$1', [targetUserId]);
      }
      if (inviteIds.length) {
        await manager.query('DELETE FROM audit_logs WHERE resource_id=ANY($1::uuid[])', [
          inviteIds.map((row) => row.id),
        ]);
      }
      await manager.query(
        `DELETE FROM audit_logs
         WHERE actor_id=$1 AND occurred_at>=$2
           AND (action LIKE 'user.%' OR action LIKE 'invite.%' OR action LIKE 'auth.%')`,
        [seededAdminId, startedAt],
      );
      await manager.query('UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=$1', [
        seededAdminId,
      ]);
      await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
    });
    await AppDataSource.destroy();
  });

  it('paginates and filters safe user detail while denying non-System-Admin access', async () => {
    const list = await fetch(
      `${apiBaseUrl}/api/v1/admin/users?q=${encodeURIComponent('lifecycle')}&role=editor&status=active&limit=1`,
      { headers: { Cookie: adminJar.header() } },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as Envelope<
      Array<{
        id: string;
        etag: string;
        security: { activeSessionCount: number; recoveryCodesRemaining: number };
      }>
    >;
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).toMatchObject({
      id: targetUserId,
      security: { activeSessionCount: 1, recoveryCodesRemaining: 2 },
    });
    expect(listBody.meta).toMatchObject({ hasMore: false, limit: 1 });

    const detail = await getTarget();
    expect(detail.response.status).toBe(200);
    expect(detail.response.headers.get('etag')).toBe(detail.body.data.etag);
    expect(detail.body.data).toMatchObject({
      id: targetUserId,
      role: 'editor',
      status: 'active',
      mfa: { enabled: true, recoveryCodesRemaining: 2 },
    });
    expect(detail.body.data.sessions[0]).toMatchObject({
      status: 'active',
      userAgent: 'target-browser-primary',
    });
    expect(JSON.stringify(detail.body)).not.toMatch(
      /tokenHash|csrfHash|ipHash|secret|codeDigest|passwordHash|payloadEncrypted/i,
    );
    targetEtag = detail.body.data.etag;

    const targetToken = targetSessionTokens.values().next().value as string;
    expect((await fetch(`${apiBaseUrl}/api/v1/admin/users/${targetUserId}`)).status).toBe(401);
    const denied = await fetch(`${apiBaseUrl}/api/v1/admin/users`, {
      headers: { Cookie: `__Host-danangmap_session=${targetToken}` },
    });
    await expectProblem(denied, 403, 'ROLE_FORBIDDEN');

    const adminDetail = await fetch(`${apiBaseUrl}/api/v1/admin/users/${seededAdminId}`, {
      headers: { Cookie: adminJar.header() },
    });
    const adminBody = (await adminDetail.json()) as Envelope<{ etag: string }>;
    const selfMutation = await adminRequest(`/api/v1/admin/users/${seededAdminId}`, {
      method: 'PATCH',
      key: key(),
      etag: adminBody.data.etag,
      body: { status: 'disabled', reason: 'Kiểm thử chặn tự khóa.' },
    });
    await expectProblem(selfMutation, 409, 'SELF_SECURITY_MUTATION_FORBIDDEN');
  });

  it('applies concurrent account commands once and revokes affected sessions atomically', async () => {
    const missingEtag = await adminRequest(`/api/v1/admin/users/${targetUserId}`, {
      method: 'PATCH',
      key: key(),
      body: { displayName: 'Không được lưu khi thiếu ETag' },
    });
    await expectProblem(missingEtag, 428, 'ETAG_REQUIRED');
    const missingReason = await adminRequest(`/api/v1/admin/users/${targetUserId}`, {
      method: 'PATCH',
      key: key(),
      etag: targetEtag,
      body: { role: 'reviewer' },
    });
    await expectProblem(missingReason, 422, 'VALIDATION_FAILED');

    const staleEtag = targetEtag;
    const concurrencyKey = key();
    const concurrent = await Promise.all([
      adminRequest(`/api/v1/admin/users/${targetUserId}`, {
        method: 'PATCH',
        key: concurrencyKey,
        etag: targetEtag,
        body: { displayName: 'Tài khoản lifecycle đã cập nhật' },
      }),
      adminRequest(`/api/v1/admin/users/${targetUserId}`, {
        method: 'PATCH',
        key: concurrencyKey,
        etag: targetEtag,
        body: { displayName: 'Tài khoản lifecycle đã cập nhật' },
      }),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const concurrentBodies = await Promise.all(
      concurrent.map((response) => response.json() as Promise<Envelope<UserDetail>>),
    );
    expect(concurrentBodies[1]?.data).toEqual(concurrentBodies[0]?.data);
    targetEtag = concurrentBodies[0]!.data.etag;
    const mismatch = await adminRequest(`/api/v1/admin/users/${targetUserId}`, {
      method: 'PATCH',
      key: concurrencyKey,
      etag: targetEtag,
      body: { displayName: 'Payload khác' },
    });
    await expectProblem(mismatch, 409, 'IDEMPOTENCY_KEY_REUSED');

    const stale = await adminRequest(`/api/v1/admin/users/${targetUserId}`, {
      method: 'PATCH',
      key: key(),
      etag: staleEtag,
      body: { displayName: 'Không được lưu' },
    });
    await expectProblem(stale, 412, 'ETAG_MISMATCH');

    const roleChange = await adminRequest(`/api/v1/admin/users/${targetUserId}`, {
      method: 'PATCH',
      key: key(),
      etag: targetEtag,
      body: { role: 'reviewer', reason: 'Điều chuyển nhiệm vụ kiểm duyệt.' },
    });
    expect(roleChange.status).toBe(200);
    const roleBody = (await roleChange.json()) as Envelope<UserDetail>;
    expect(roleBody.data.role).toBe('reviewer');
    targetEtag = roleBody.data.etag;
    const oldToken = targetSessionTokens.values().next().value as string;
    expect(
      (
        await fetch(`${apiBaseUrl}/api/v1/auth/me`, {
          headers: { Cookie: `__Host-danangmap_session=${oldToken}` },
        })
      ).status,
    ).toBe(401);

    const disabled = await adminRequest(`/api/v1/admin/users/${targetUserId}`, {
      method: 'PATCH',
      key: key(),
      etag: targetEtag,
      body: { status: 'disabled', reason: 'Tạm khóa để kiểm tra lifecycle.' },
    });
    const disabledBody = (await disabled.json()) as Envelope<UserDetail>;
    expect(disabledBody.data.status).toBe('disabled');
    targetEtag = disabledBody.data.etag;
    const reactivated = await adminRequest(`/api/v1/admin/users/${targetUserId}`, {
      method: 'PATCH',
      key: key(),
      etag: targetEtag,
      body: { status: 'active', reason: 'Hoàn tất xác minh và kích hoạt lại.', unlock: true },
    });
    const reactivatedBody = (await reactivated.json()) as Envelope<UserDetail>;
    expect(reactivatedBody.data.status).toBe('active');
    targetEtag = reactivatedBody.data.etag;

    const sessionA = await createSession(targetUserId, 'target-session-a');
    const sessionB = await createSession(targetUserId, 'target-session-b');
    targetSessionTokens.set(sessionA.id, sessionA.token);
    targetSessionTokens.set(sessionB.id, sessionB.token);
    targetEtag = (await getTarget()).body.data.etag;
    const revokeOne = await adminRequest(
      `/api/v1/admin/users/${targetUserId}/sessions/${sessionA.id}:revoke`,
      {
        method: 'POST',
        key: key(),
        etag: targetEtag,
        body: { reason: 'Thiết bị không còn được sử dụng.' },
      },
    );
    expect(revokeOne.status).toBe(200);
    const revokeOneBody = (await revokeOne.json()) as Envelope<{
      revokedCount: number;
      etag: string;
    }>;
    expect(revokeOneBody.data.revokedCount).toBe(1);
    targetEtag = revokeOneBody.data.etag;
    expect(await sessionMe(sessionA.token)).toBe(401);
    expect(await sessionMe(sessionB.token)).toBe(200);

    const revokeAll = await adminRequest(
      `/api/v1/admin/users/${targetUserId}/sessions:revoke-all`,
      {
        method: 'POST',
        key: key(),
        etag: targetEtag,
        body: { reason: 'Buộc đăng nhập lại trên mọi thiết bị.' },
      },
    );
    expect(revokeAll.status).toBe(200);
    const revokeAllBody = (await revokeAll.json()) as Envelope<{
      revokedCount: number;
      etag: string;
    }>;
    expect(revokeAllBody.data.revokedCount).toBe(1);
    expect(await sessionMe(sessionB.token)).toBe(401);
    targetEtag = revokeAllBody.data.etag;

    const mfaReset = await adminRequest(`/api/v1/admin/users/${targetUserId}/mfa:reset`, {
      method: 'POST',
      key: key(),
      etag: targetEtag,
      body: { reason: 'Người dùng báo mất thiết bị MFA.' },
    });
    expect(mfaReset.status).toBe(200);
    const mfaBody = (await mfaReset.json()) as Envelope<{
      mfaEnrollmentRequired: boolean;
      etag: string;
    }>;
    expect(mfaBody.data.mfaEnrollmentRequired).toBe(true);
    expect(JSON.stringify(mfaBody)).not.toMatch(/secret|recoveryCode|token/i);
    targetEtag = mfaBody.data.etag;
    const factors = (await AppDataSource.query(
      `SELECT u.mfa_enabled,
              (SELECT count(*)::integer FROM user_mfa_methods WHERE user_id=u.id) AS methods,
              (SELECT count(*)::integer FROM user_mfa_recovery_codes WHERE user_id=u.id) AS codes
       FROM users u WHERE u.id=$1`,
      [targetUserId],
    )) as Array<{ mfa_enabled: boolean; methods: number; codes: number }>;
    expect(factors[0]).toEqual({ mfa_enabled: false, methods: 0, codes: 0 });

    const passwordReset = await adminRequest(
      `/api/v1/admin/users/${targetUserId}/password-reset:request`,
      {
        method: 'POST',
        key: key(),
        etag: targetEtag,
        body: { reason: 'Hỗ trợ người dùng khôi phục truy cập.' },
      },
    );
    expect(passwordReset.status).toBe(202);
    const resetText = await passwordReset.text();
    const resetBody = JSON.parse(resetText) as Envelope<{
      status: string;
      deliveryStatus: string;
      etag: string;
    }>;
    expect(resetBody.data).toMatchObject({ status: 'accepted', deliveryStatus: 'pending' });
    const mail = await waitForMailpitMessage(targetEmail);
    expect(mail.subject.toLocaleLowerCase('vi')).toContain('đặt lại mật khẩu');
    expect(resetText).not.toContain(mail.code);
    expect(resetText).not.toContain('passwordResetToken');
    targetEtag = resetBody.data.etag;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const repeatedReset = await adminRequest(
        `/api/v1/admin/users/${targetUserId}/password-reset:request`,
        {
          method: 'POST',
          key: key(),
          etag: targetEtag,
          body: { reason: `Kiểm thử giới hạn yêu cầu lần ${attempt + 2}.` },
        },
      );
      expect(repeatedReset.status).toBe(202);
      targetEtag = ((await repeatedReset.json()) as Envelope<{ etag: string }>).data.etag;
    }
    const rateLimited = await adminRequest(
      `/api/v1/admin/users/${targetUserId}/password-reset:request`,
      {
        method: 'POST',
        key: key(),
        etag: targetEtag,
        body: { reason: 'Yêu cầu vượt giới hạn bảo mật.' },
      },
    );
    await expectProblem(rateLimited, 429, 'RATE_LIMITED');
  });

  it('lists and resends invites with one replacement credential and no token leakage', async () => {
    const createInvite = await adminRequest('/api/v1/admin/invites', {
      method: 'POST',
      key: key(),
      body: {
        email: inviteEmail,
        username: `admin-invite-${suffix}`,
        displayName: 'Tài khoản được mời',
        role: 'editor',
        expiresInHours: 24,
      },
    });
    expect(createInvite.status).toBe(202);
    const originalBody = (await createInvite.json()) as Envelope<{ id: string }>;
    const originalMail = await waitForMailpitMessage(inviteEmail, 1);
    const list = await fetch(
      `${apiBaseUrl}/api/v1/admin/invites?q=${encodeURIComponent(inviteEmail)}&status=pending&limit=10`,
      { headers: { Cookie: adminJar.header() } },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as Envelope<Array<{ id: string; etag: string }>>;
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.id).toBe(originalBody.data.id);

    const resendKey = key();
    const resent = await adminRequest(`/api/v1/admin/invites/${originalBody.data.id}:resend`, {
      method: 'POST',
      key: resendKey,
      etag: listBody.data[0]!.etag,
      body: { reason: 'Người nhận chưa nhận được thư.', expiresInHours: 48 },
    });
    expect(resent.status).toBe(202);
    const resentText = await resent.text();
    const resentBody = JSON.parse(resentText) as Envelope<{
      id: string;
      supersedesInviteId: string;
      etag: string;
    }>;
    expect(resentBody.data.supersedesInviteId).toBe(originalBody.data.id);
    expect(resentBody.data.id).not.toBe(originalBody.data.id);
    const replacementMail = await waitForMailpitMessage(inviteEmail, 2);
    expect(replacementMail.code).not.toBe(originalMail.code);
    expect(resentText).not.toContain(originalMail.code);
    expect(resentText).not.toContain(replacementMail.code);

    const replay = await adminRequest(`/api/v1/admin/invites/${originalBody.data.id}:resend`, {
      method: 'POST',
      key: resendKey,
      etag: listBody.data[0]!.etag,
      body: { reason: 'Người nhận chưa nhận được thư.', expiresInHours: 48 },
    });
    expect(replay.status).toBe(202);
    expect(((await replay.json()) as Envelope<{ id: string }>).data.id).toBe(resentBody.data.id);
    const counts = (await AppDataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM invites WHERE lower(email)=lower($1)) AS invites,
         (SELECT count(*)::integer FROM mail_outbox WHERE recipient_email=$1
           AND template_key='identity.invite') AS outboxes`,
      [inviteEmail],
    )) as Array<{ invites: number; outboxes: number }>;
    expect(counts[0]).toEqual({ invites: 2, outboxes: 2 });

    const changedReplay = await adminRequest(
      `/api/v1/admin/invites/${originalBody.data.id}:resend`,
      {
        method: 'POST',
        key: resendKey,
        etag: listBody.data[0]!.etag,
        body: { reason: 'Payload đã thay đổi.', expiresInHours: 72 },
      },
    );
    await expectProblem(changedReplay, 409, 'IDEMPOTENCY_KEY_REUSED');
    const originalInspect = await fetch(`${apiBaseUrl}/api/v1/auth/invites:inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: originalMail.code }),
    });
    await expectProblem(originalInspect, 400, 'INVITE_INVALID_OR_EXPIRED');
  });

  function key(): string {
    const value = randomUUID();
    idempotencyKeys.push(value);
    return value;
  }

  async function getTarget(): Promise<{
    response: Response;
    body: Envelope<UserDetail>;
  }> {
    const response = await fetch(`${apiBaseUrl}/api/v1/admin/users/${targetUserId}`, {
      headers: { Cookie: adminJar.header() },
    });
    return { response, body: (await response.json()) as Envelope<UserDetail> };
  }

  async function adminRequest(
    path: string,
    options: {
      method: 'POST' | 'PATCH';
      key: string;
      body: Record<string, unknown>;
      etag?: string;
    },
  ): Promise<Response> {
    return fetch(`${apiBaseUrl}${path}`, {
      method: options.method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: adminJar.header(),
        Origin: allowedOrigin,
        'X-CSRF-Token': adminJar.get('danangmap_csrf') ?? '',
        'Idempotency-Key': options.key,
        ...(options.etag ? { 'If-Match': options.etag } : {}),
      },
      body: JSON.stringify(options.body),
    });
  }
});

async function createSession(
  userId: string,
  userAgent: string,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  await AppDataSource.query(
    `INSERT INTO admin_sessions(
       id,user_id,token_hash,csrf_hash,kind,expires_at,revoked_at,ip_hash,user_agent
     ) VALUES($1,$2,$3,$4,'authenticated',now()+interval '1 hour',NULL,NULL,$5)`,
    [id, userId, digest(token), digest(csrf), userAgent],
  );
  return { id, token };
}

async function sessionMe(token: string): Promise<number> {
  return (
    await fetch(`${apiBaseUrl}/api/v1/auth/me`, {
      headers: { Cookie: `__Host-danangmap_session=${token}` },
    })
  ).status;
}

async function loginAdmin(): Promise<CookieJar> {
  const jar = new CookieJar();
  const csrf = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: { Cookie: jar.header() },
  });
  jar.absorb(csrf);
  const login = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: jar.header(),
      Origin: allowedOrigin,
      'X-CSRF-Token': jar.get('danangmap_csrf') ?? '',
    },
    body: JSON.stringify({
      login: 'system-admin@danangmap.local',
      password: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-2026!',
    }),
  });
  expect(login.status).toBe(200);
  jar.absorb(login);
  const verified = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: jar.header(),
      Origin: allowedOrigin,
      'X-CSRF-Token': jar.get('danangmap_csrf') ?? '',
    },
    body: JSON.stringify({ method: 'totp', code: generateTotp(seededMfaSecret) }),
  });
  expect(verified.status).toBe(200);
  jar.absorb(verified);
  return jar;
}

async function expectProblem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const problem = (await response.json()) as { status: number; code: string; requestId: string };
  expect(problem).toMatchObject({ status, code });
  expect(problem.requestId).toBeDefined();
}

function digest(value: string): string {
  const pepper = process.env.SESSION_PEPPER ?? 'local-only-session-pepper-change-in-production';
  return createHash('sha256').update(`${value}:${pepper}`).digest('hex');
}

function generateTotp(secret: string, epoch = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replaceAll('=', '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value >= 0) bits += value.toString(2).padStart(5, '0');
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < key.length; index += 1) {
    key[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const counter = BigInt(Math.floor(epoch / 30_000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}
