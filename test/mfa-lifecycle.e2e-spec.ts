import { createHmac, randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import { E2E_PREAUTH_COOKIE, E2E_SESSION_COOKIE } from './auth-cookie.helper';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
const allowedOrigin = 'http://localhost:3000';
const seededAdminId = '00000000-0000-4000-8000-000000000001';
const seededEditorId = '00000000-0000-4000-8000-000000000002';
const seededEditorSecret = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

jest.setTimeout(60_000);

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

  clone(): CookieJar {
    return new CookieJar(Object.fromEntries(this.values));
  }
}

interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}

describe('MFA enrollment and recovery HTTP lifecycle', () => {
  const testStartedAt = new Date();
  const fixtureKey = randomUUID();
  let userId = '';
  const login = `mfa-${fixtureKey.slice(0, 8)}@example.gov.vn`;
  const username = `mfa-${fixtureKey.slice(0, 8)}`;
  const password = 'Manual-Mfa-Password-2026!';

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])',
      [[seededAdminId, seededEditorId]],
    );
    const adminLogin = await loginWithPassword(
      'system-admin@danangmap.local',
      process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-2026!',
    );
    const adminTotp = generateTotp(seededEditorSecret);
    const adminVerify = await postWithCsrf('/api/v1/auth/mfa/verify', adminLogin.jar, {
      method: 'totp',
      code: adminTotp,
    });
    expect(adminVerify.status).toBe(200);
    adminLogin.jar.absorb(adminVerify);
    const createResponse = await fetch(`${apiBaseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(adminLogin.jar, adminLogin.jar.get('danangmap_csrf'), allowedOrigin),
        'Idempotency-Key': fixtureKey,
      },
      body: JSON.stringify({
        email: login,
        username,
        displayName: 'MFA lifecycle user',
        role: 'editor',
        delivery: 'manual',
        temporaryPassword: password,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as Envelope<{ id: string; mfaEnabled: boolean }>;
    expect(created.data.mfaEnabled).toBe(false);
    userId = created.data.id;
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query('DELETE FROM admin_sessions WHERE user_id=ANY($1::uuid[])', [
        [userId, seededAdminId, seededEditorId],
      ]);
      await manager.query('DELETE FROM command_receipts WHERE idempotency_key=$1', [fixtureKey]);
      if (userId) {
        await manager.query('DELETE FROM command_receipts WHERE actor_id=$1', [userId]);
        await manager.query('DELETE FROM audit_logs WHERE actor_id=$1 OR resource_id=$1', [userId]);
        await manager.query('DELETE FROM users WHERE id=$1', [userId]);
      }
      await manager.query(
        `DELETE FROM audit_logs
         WHERE actor_id=ANY($1::uuid[]) AND action LIKE 'auth.%' AND occurred_at >= $2`,
        [[seededAdminId, seededEditorId], testStartedAt],
      );
      await manager.query(
        'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])',
        [[seededAdminId, seededEditorId]],
      );
      await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
    });
    await AppDataSource.destroy();
  });

  it('enrolls, confirms and consumes MFA factors exactly once', async () => {
    const staleJar = new CookieJar({ [E2E_SESSION_COOKIE]: 'expired-browser-cookie' });
    const publicCsrf = await getCsrfToken(staleJar);
    expect(publicCsrf.response.status).toBe(200);
    expect(publicCsrf.response.headers.get('cache-control')).toBe('private, no-store');
    expect(staleJar.get('danangmap_csrf')).toBe(publicCsrf.token);
    const repeatedPublicCsrf = await getCsrfToken(staleJar);
    expect(repeatedPublicCsrf.token).toBe(publicCsrf.token);

    const noOriginLogin = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: jsonHeaders(staleJar, publicCsrf.token),
      body: JSON.stringify({ login, password }),
    });
    await expectProblem(noOriginLogin, 403, 'CSRF_INVALID');

    const wrongCsrfLogin = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: jsonHeaders(staleJar, `${publicCsrf.token}-wrong`, allowedOrigin),
      body: JSON.stringify({ login, password }),
    });
    await expectProblem(wrongCsrfLogin, 403, 'CSRF_INVALID');

    const enrollmentJar = await loginWithPassword(login, password, staleJar);
    expect(enrollmentJar.body.data).toMatchObject({
      status: 'mfa_required',
      mfaEnrollmentRequired: true,
    });
    const loginCsrf = enrollmentJar.jar.get('danangmap_csrf');
    expect(loginCsrf).toBeDefined();
    expect(loginCsrf).not.toBe(publicCsrf.token);
    const preauthSession = await latestSessionState(userId, 'preauth');
    const sequentialPreauthA = await getCsrfToken(enrollmentJar.jar);
    const sequentialPreauthB = await getCsrfToken(enrollmentJar.jar);
    expect([sequentialPreauthA.token, sequentialPreauthB.token]).toEqual([loginCsrf, loginCsrf]);
    expect(sequentialPreauthA.response.headers.get('cache-control')).toBe('private, no-store');
    expect(await sessionCsrfHash(preauthSession.id)).toBe(preauthSession.csrfHash);

    const tabAJar = enrollmentJar.jar.clone();
    const tabBJar = enrollmentJar.jar.clone();
    const [tabACsrf, tabBCsrf] = await Promise.all([getCsrfToken(tabAJar), getCsrfToken(tabBJar)]);
    expect([tabACsrf.token, tabBCsrf.token]).toEqual([loginCsrf, loginCsrf]);
    expect(await sessionCsrfHash(preauthSession.id)).toBe(preauthSession.csrfHash);

    const preauthCookie = enrollmentJar.jar.get(E2E_PREAUTH_COOKIE)!;
    for (const invalidJar of [
      new CookieJar({ [E2E_PREAUTH_COOKIE]: preauthCookie }),
      new CookieJar({
        [E2E_PREAUTH_COOKIE]: preauthCookie,
        danangmap_csrf: 'malformed-token',
      }),
      new CookieJar({
        [E2E_PREAUTH_COOKIE]: preauthCookie,
        danangmap_csrf: 'C'.repeat(32),
      }),
    ]) {
      await expectProblem(await requestCsrf(invalidJar), 403, 'CSRF_INVALID');
      expect(await sessionCsrfHash(preauthSession.id)).toBe(preauthSession.csrfHash);
    }

    const foreignPreauth = await loginWithPassword(login, password);
    const crossSessionJar = new CookieJar({
      [E2E_PREAUTH_COOKIE]: preauthCookie,
      danangmap_csrf: foreignPreauth.jar.get('danangmap_csrf')!,
    });
    await expectProblem(await requestCsrf(crossSessionJar), 403, 'CSRF_INVALID');
    await expectProblem(
      await postWithCsrf('/api/v1/auth/mfa/enroll', crossSessionJar),
      403,
      'CSRF_INVALID',
    );
    expect(await sessionCsrfHash(preauthSession.id)).toBe(preauthSession.csrfHash);

    const missingOriginEnroll = await postWithCsrf(
      '/api/v1/auth/mfa/enroll',
      enrollmentJar.jar,
      undefined,
      null,
    );
    await expectProblem(missingOriginEnroll, 403, 'CSRF_INVALID');
    const wrongOriginEnroll = await postWithCsrf(
      '/api/v1/auth/mfa/enroll',
      enrollmentJar.jar,
      undefined,
      'https://attacker.example',
    );
    await expectProblem(wrongOriginEnroll, 403, 'CSRF_INVALID');
    const wrongTokenEnroll = await postWithCsrf(
      '/api/v1/auth/mfa/enroll',
      enrollmentJar.jar,
      undefined,
      allowedOrigin,
      'wrong-token',
    );
    await expectProblem(wrongTokenEnroll, 403, 'CSRF_INVALID');
    const wrongPreauthCookie = new CookieJar({
      [E2E_PREAUTH_COOKIE]: 'not-a-valid-preauth-session',
      danangmap_csrf: enrollmentJar.jar.get('danangmap_csrf')!,
    });
    const wrongCookieConfirm = await postWithCsrf(
      '/api/v1/auth/mfa/enroll/confirm',
      wrongPreauthCookie,
      { code: '000000' },
    );
    expect(wrongCookieConfirm.status).toBe(401);

    const sharedPreauthJar = enrollmentJar.jar.clone();
    sharedPreauthJar.absorb(tabACsrf.response);
    sharedPreauthJar.absorb(tabBCsrf.response);
    const firstStart = await postWithCsrf(
      '/api/v1/auth/mfa/enroll',
      sharedPreauthJar,
      undefined,
      allowedOrigin,
      tabACsrf.token,
    );
    expect(firstStart.status).toBe(200);
    expect(await sessionCsrfHash(preauthSession.id)).toBe(preauthSession.csrfHash);
    const enrollBody = (await firstStart.json()) as Envelope<{
      status: string;
      enrollmentUri: string;
    }>;
    expect(enrollBody.data.status).toBe('pending');
    const firstEnrollmentUri = enrollBody.data.enrollmentUri;
    const replayEnroll = await postWithCsrf('/api/v1/auth/mfa/enroll', enrollmentJar.jar);
    await expectProblem(replayEnroll, 409, 'AUTH_MFA_ENROLLMENT_ALREADY_STARTED');
    const firstSecret = enrollmentSecret(firstEnrollmentUri);

    const rotatedEnrollment = await loginWithPassword(login, password);
    const concurrentStarts = await Promise.all([
      postWithCsrf('/api/v1/auth/mfa/enroll', rotatedEnrollment.jar),
      postWithCsrf('/api/v1/auth/mfa/enroll', rotatedEnrollment.jar),
    ]);
    expect(concurrentStarts.map((response) => response.status).sort()).toEqual([200, 409]);
    const rotatedStart = concurrentStarts.find((response) => response.status === 200)!;
    const rotatedUri = ((await rotatedStart.json()) as Envelope<{ enrollmentUri: string }>).data
      .enrollmentUri;
    expect(rotatedUri).not.toBe(firstEnrollmentUri);
    expect(enrollmentSecret(rotatedUri)).not.toBe(firstSecret);
    const oldSessionConfirm = await postWithCsrf(
      '/api/v1/auth/mfa/enroll/confirm',
      enrollmentJar.jar,
      { code: generateTotp(firstSecret) },
    );
    await expectProblem(oldSessionConfirm, 409, 'AUTH_MFA_ENROLLMENT_STALE');

    const expired = await loginWithPassword(login, password);
    const expiredStart = await postWithCsrf('/api/v1/auth/mfa/enroll', expired.jar);
    expect(expiredStart.status).toBe(200);
    await AppDataSource.query(
      `UPDATE admin_sessions SET expires_at=now()-interval '1 second'
       WHERE token_hash=(
         SELECT token_hash FROM admin_sessions WHERE user_id=$1 AND kind='preauth'
         ORDER BY created_at DESC LIMIT 1
       )`,
      [userId],
    );
    const expiredEnroll = await postWithCsrf('/api/v1/auth/mfa/enroll', expired.jar);
    expect(expiredEnroll.status).toBe(401);
    await AppDataSource.query(
      `DELETE FROM admin_sessions
       WHERE user_id=$1 AND kind='preauth' AND expires_at<now()`,
      [userId],
    );
    const pendingAfterExpiry = (await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM user_mfa_methods
       WHERE user_id=$1 AND status='pending'`,
      [userId],
    )) as Array<{ count: number }>;
    expect(pendingAfterExpiry[0]?.count).toBe(0);

    const rateLimited = await loginWithPassword(login, password);
    const rateStart = await postWithCsrf('/api/v1/auth/mfa/enroll', rateLimited.jar);
    expect(rateStart.status).toBe(200);
    const rateSecret = enrollmentSecret(
      ((await rateStart.json()) as Envelope<{ enrollmentUri: string }>).data.enrollmentUri,
    );
    const currentStep = Math.floor(Date.now() / 1_000 / 30);
    const nearbyTokens = new Set(
      [-1, 0, 1].map((delta) => generateTotp(rateSecret, (currentStep + delta) * 30 + 1)),
    );
    let invalidTotp = '000000';
    while (nearbyTokens.has(invalidTotp)) {
      invalidTotp = String((Number(invalidTotp) + 1) % 1_000_000).padStart(6, '0');
    }
    const invalidCodes = await Promise.all(
      Array.from({ length: 5 }, () =>
        postWithCsrf('/api/v1/auth/mfa/enroll/confirm', rateLimited.jar, { code: invalidTotp }),
      ),
    );
    expect(invalidCodes.map((response) => response.status).sort()).toEqual([
      401, 401, 401, 401, 429,
    ]);
    const lockedRetry = await postWithCsrf('/api/v1/auth/mfa/enroll/confirm', rateLimited.jar, {
      code: invalidTotp,
    });
    await expectProblem(lockedRetry, 429, 'AUTH_MFA_RATE_LIMITED');

    const confirmJar = await loginWithPassword(login, password);
    const confirmStart = await postWithCsrf('/api/v1/auth/mfa/enroll', confirmJar.jar);
    expect(confirmStart.status).toBe(200);
    const secret = enrollmentSecret(
      ((await confirmStart.json()) as Envelope<{ enrollmentUri: string }>).data.enrollmentUri,
    );
    const currentToken = generateTotp(secret);
    const confirmRequests = await Promise.all([
      postWithCsrf('/api/v1/auth/mfa/enroll/confirm', confirmJar.jar, { code: currentToken }),
      postWithCsrf('/api/v1/auth/mfa/enroll/confirm', confirmJar.jar, { code: currentToken }),
    ]);
    expect(confirmRequests.map((response) => response.status).sort()).toEqual([200, 401]);
    const successfulConfirm = confirmRequests.find((response) => response.status === 200)!;
    const confirmedPreauthCsrf = confirmJar.jar.get('danangmap_csrf');
    const authenticatedJar = confirmJar.jar.clone();
    authenticatedJar.absorb(successfulConfirm);
    const confirmed = (await successfulConfirm.json()) as Envelope<{
      principal: { id: string; mfaEnabled: boolean };
      recoveryCodes: string[];
    }>;
    expect(confirmed.data.principal).toMatchObject({ id: userId, mfaEnabled: true });
    expect(confirmed.data.recoveryCodes).toHaveLength(10);
    expect(new Set(confirmed.data.recoveryCodes).size).toBe(10);
    expect(confirmed.data.recoveryCodes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/)]),
    );
    const initialRecoveryCodes = confirmed.data.recoveryCodes;
    const authenticatedToken = authenticatedJar.get('danangmap_csrf');
    expect(authenticatedToken).toBeDefined();
    expect(authenticatedToken).not.toBe(confirmedPreauthCsrf);

    const replayConfirm = await postWithCsrf('/api/v1/auth/mfa/enroll/confirm', confirmJar.jar, {
      code: currentToken,
    });
    expect(replayConfirm.status).toBe(401);
    const me = await fetch(`${apiBaseUrl}/api/v1/auth/me`, {
      headers: { Cookie: authenticatedJar.header() },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as Envelope<{ id: string; mfaEnabled: boolean }>).data).toMatchObject(
      {
        id: userId,
        mfaEnabled: true,
      },
    );
    const authenticatedSession = await latestSessionState(userId, 'authenticated');
    const authenticatedCsrfA = await getCsrfToken(authenticatedJar);
    const authenticatedCsrfB = await getCsrfToken(authenticatedJar);
    expect([authenticatedCsrfA.token, authenticatedCsrfB.token]).toEqual([
      authenticatedToken,
      authenticatedToken,
    ]);
    const authenticatedTabAJar = authenticatedJar.clone();
    const authenticatedTabBJar = authenticatedJar.clone();
    const [authenticatedTabA, authenticatedTabB] = await Promise.all([
      getCsrfToken(authenticatedTabAJar),
      getCsrfToken(authenticatedTabBJar),
    ]);
    expect([authenticatedTabA.token, authenticatedTabB.token]).toEqual([
      authenticatedToken,
      authenticatedToken,
    ]);
    expect(await sessionCsrfHash(authenticatedSession.id)).toBe(authenticatedSession.csrfHash);

    const wrongPasswordRegeneration = await postWithCsrf(
      '/api/v1/auth/mfa/recovery-codes:regenerate',
      authenticatedJar,
      { password: `${password}-wrong`, mfaCode: initialRecoveryCodes[1] },
      allowedOrigin,
      undefined,
      { 'Idempotency-Key': randomUUID() },
    );
    await expectProblem(wrongPasswordRegeneration, 401, 'AUTH_INVALID_CREDENTIALS');
    const wrongMfaRegeneration = await postWithCsrf(
      '/api/v1/auth/mfa/recovery-codes:regenerate',
      authenticatedJar,
      { password, mfaCode: '000000' },
      allowedOrigin,
      undefined,
      { 'Idempotency-Key': randomUUID() },
    );
    await expectProblem(wrongMfaRegeneration, 401, 'AUTH_MFA_INVALID');

    const regenerationKey = randomUUID();
    const regenerationRequests = await Promise.all([
      postWithCsrf(
        '/api/v1/auth/mfa/recovery-codes:regenerate',
        authenticatedJar,
        { password, mfaCode: initialRecoveryCodes[1] },
        allowedOrigin,
        undefined,
        { 'Idempotency-Key': regenerationKey },
      ),
      postWithCsrf(
        '/api/v1/auth/mfa/recovery-codes:regenerate',
        authenticatedJar,
        { password, mfaCode: initialRecoveryCodes[1] },
        allowedOrigin,
        undefined,
        { 'Idempotency-Key': regenerationKey },
      ),
    ]);
    expect(regenerationRequests.map((response) => response.status).sort()).toEqual([200, 409]);
    const regenerationSuccess = regenerationRequests.find((response) => response.status === 200)!;
    const regenerationReplay = regenerationRequests.find((response) => response.status === 409)!;
    await expectProblem(regenerationReplay, 409, 'RECOVERY_CODES_ALREADY_REGENERATED');
    const regenerated = (await regenerationSuccess.json()) as Envelope<{
      status: string;
      recoveryCodes: string[];
    }>;
    expect(regenerated.data.status).toBe('recovery_codes_regenerated');
    expect(regenerated.data.recoveryCodes).toHaveLength(10);
    expect(new Set(regenerated.data.recoveryCodes).size).toBe(10);
    expect(regenerated.data.recoveryCodes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/)]),
    );
    expect(regenerated.data.recoveryCodes).not.toEqual(
      expect.arrayContaining(initialRecoveryCodes),
    );
    const activeRecoveryCodes = regenerated.data.recoveryCodes;

    const authOnlyEnroll = await postWithCsrf('/api/v1/auth/mfa/enroll', authenticatedJar);
    expect(authOnlyEnroll.status).toBe(401);
    const sharedAuthenticatedJar = authenticatedJar.clone();
    sharedAuthenticatedJar.absorb(authenticatedTabA.response);
    sharedAuthenticatedJar.absorb(authenticatedTabB.response);
    const logout = await postWithCsrf(
      '/api/v1/auth/logout',
      sharedAuthenticatedJar,
      undefined,
      allowedOrigin,
      authenticatedTabA.token,
    );
    expect(logout.status).toBe(200);
    expect(await sessionCsrfHash(authenticatedSession.id)).toBe(authenticatedSession.csrfHash);
    const alreadyEnabled = await loginWithPassword(login, password);
    expect(alreadyEnabled.body.data.mfaEnrollmentRequired).toBe(false);
    const forbiddenEnroll = await postWithCsrf('/api/v1/auth/mfa/enroll', alreadyEnabled.jar);
    await expectProblem(forbiddenEnroll, 409, 'AUTH_MFA_ALREADY_ENROLLED');

    // The verifier explicitly allows 30 seconds of drift; use the next step to test replay
    // without sleeping for the current enrollment step to expire.
    const nextStepEpoch = (Math.floor(Date.now() / 1_000 / 30) + 1) * 30 + 1;
    const nextToken = generateTotp(secret, nextStepEpoch);
    const totpA = await loginWithPassword(login, password);
    const totpB = await loginWithPassword(login, password);
    const totpReplay = await Promise.all([
      postWithCsrf('/api/v1/auth/mfa/verify', totpA.jar, {
        method: 'totp',
        code: nextToken,
      }),
      postWithCsrf('/api/v1/auth/mfa/verify', totpB.jar, {
        method: 'totp',
        code: nextToken,
      }),
    ]);
    expect(totpReplay.map((response) => response.status).sort()).toEqual([200, 401]);

    const recoveryA = await loginWithPassword(login, password);
    const recoveryB = await loginWithPassword(login, password);
    const firstRecoveryCode = activeRecoveryCodes[0]!;
    const recoveryReplay = await Promise.all([
      postWithCsrf('/api/v1/auth/mfa/verify', recoveryA.jar, {
        method: 'recovery_code',
        code: firstRecoveryCode,
      }),
      postWithCsrf('/api/v1/auth/mfa/verify', recoveryB.jar, {
        method: 'recovery_code',
        code: firstRecoveryCode,
      }),
    ]);
    expect(recoveryReplay.map((response) => response.status).sort()).toEqual([200, 401]);

    const recoveryRows = (await AppDataSource.query(
      `SELECT code_digest,consumed_at FROM user_mfa_recovery_codes WHERE user_id=$1 ORDER BY created_at`,
      [userId],
    )) as Array<{ code_digest: string; consumed_at: Date | null }>;
    expect(recoveryRows).toHaveLength(10);
    expect(recoveryRows.filter((row) => row.consumed_at)).toHaveLength(1);
    expect(recoveryRows.map((row) => row.code_digest)).not.toEqual(
      expect.arrayContaining(confirmed.data.recoveryCodes),
    );
    const audits = (await AppDataSource.query(
      `SELECT metadata::text AS metadata FROM audit_logs WHERE actor_id=$1`,
      [userId],
    )) as Array<{ metadata: string }>;
    const serializedAudit = JSON.stringify(audits);
    expect(serializedAudit).not.toContain('otpauth://');
    expect(serializedAudit).not.toContain(secret);
    for (const rawCode of [...initialRecoveryCodes, ...activeRecoveryCodes]) {
      expect(serializedAudit).not.toContain(rawCode);
    }
  });

  it('keeps a pre-migration enabled seeded user able to authenticate by TOTP', async () => {
    const loginResult = await loginWithPassword(
      'editor@danangmap.local',
      process.env.SEED_EDITOR_PASSWORD ?? 'ChangeMe-Editor-2026!',
    );
    expect(loginResult.body.data.mfaEnrollmentRequired).toBe(false);
    const token = generateTotp(seededEditorSecret);
    const response = await postWithCsrf('/api/v1/auth/mfa/verify', loginResult.jar, {
      method: 'totp',
      code: token,
    });
    expect(response.status).toBe(200);
  });
});

async function requestCsrf(jar: CookieJar): Promise<Response> {
  return fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: jar.header() ? { Cookie: jar.header() } : undefined,
  });
}

async function getCsrfToken(jar: CookieJar) {
  const response = await requestCsrf(jar);
  expect(response.status).toBe(200);
  jar.absorb(response);
  const body = (await response.json()) as Envelope<{ csrfToken: string }>;
  return { response, token: body.data.csrfToken };
}

async function loginWithPassword(login: string, password: string, jar = new CookieJar()) {
  const { token } = await getCsrfToken(jar);
  const response = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: jsonHeaders(jar, token, allowedOrigin),
    body: JSON.stringify({ login, password }),
  });
  expect(response.status).toBe(200);
  jar.absorb(response);
  const body = (await response.json()) as Envelope<{
    status: string;
    mfaEnrollmentRequired: boolean;
  }>;
  return { response, jar, body };
}

async function postWithCsrf(
  path: string,
  jar: CookieJar,
  body?: Record<string, unknown>,
  origin: string | null = allowedOrigin,
  overrideToken?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...jsonHeaders(jar, overrideToken ?? jar.get('danangmap_csrf'), origin ?? undefined),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function jsonHeaders(jar: CookieJar, csrfToken?: string, origin?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(jar.header() ? { Cookie: jar.header() } : {}),
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    ...(origin ? { Origin: origin } : {}),
  };
}

function enrollmentSecret(enrollmentUri: string): string {
  const secret = new URL(enrollmentUri).searchParams.get('secret');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  if (!secret) throw new Error('Enrollment URI did not contain a TOTP secret');
  return secret;
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

async function latestSessionState(userId: string, kind: 'preauth' | 'authenticated') {
  const rows = (await AppDataSource.query(
    `SELECT id,csrf_hash AS "csrfHash"
     FROM admin_sessions
     WHERE user_id=$1 AND kind=$2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, kind],
  )) as Array<{ id: string; csrfHash: string }>;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function sessionCsrfHash(sessionId: string): Promise<string> {
  const rows = (await AppDataSource.query(
    'SELECT csrf_hash AS "csrfHash" FROM admin_sessions WHERE id=$1',
    [sessionId],
  )) as Array<{ csrfHash: string }>;
  expect(rows).toHaveLength(1);
  return rows[0]!.csrfHash;
}

async function expectProblem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.clone().json()).resolves.toMatchObject({ status, code });
}
