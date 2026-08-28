jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verify: jest.fn(),
}));
jest.mock('argon2', () => ({
  __esModule: true,
  default: { verify: jest.fn().mockResolvedValue(true) },
}));

import { AuthService } from './auth.service';

const token = 'A'.repeat(32);
const tokenDigest = '1'.repeat(64);

function subject() {
  const users = {
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const sessions = {
    findOneBy: jest.fn(),
    update: jest.fn(),
  };
  const crypto = {
    digest: jest.fn((value: string) => (value === token ? tokenDigest : '2'.repeat(64))),
    randomToken: jest.fn(() => 'B'.repeat(32)),
  };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn((key: string) => (key === 'app.mfaEnabled' ? false : undefined)) };
  const manager = {
    create: jest.fn((_entity: unknown, value: Record<string, unknown>) => ({
      ...value,
      id: '22222222-2222-4222-8222-222222222222',
    })),
    save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
  };
  const dataSource = { manager, transaction: jest.fn() };
  const service = new AuthService(
    users as never,
    sessions as never,
    {} as never,
    {} as never,
    crypto as never,
    audit as never,
    config as never,
    dataSource as never,
    {} as never,
    {} as never,
  );
  return { service, users, sessions, crypto, audit, config, dataSource, manager };
}

describe('AuthService session-bound CSRF tokens', () => {
  it('returns the same active session token for sequential and parallel reads without updates', async () => {
    const { service, sessions } = subject();
    sessions.findOneBy.mockResolvedValue({
      csrfHash: tokenDigest,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.getSessionCsrf('session-1', token)).resolves.toBe(token);
    await expect(service.getSessionCsrf('session-1', token)).resolves.toBe(token);
    await expect(
      Promise.all([
        service.getSessionCsrf('session-1', token),
        service.getSessionCsrf('session-1', token),
      ]),
    ).resolves.toEqual([token, token]);
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it.each([
    ['missing token', undefined, null],
    ['malformed token', 'not-base64url', null],
    ['mismatched token', 'C'.repeat(32), activeSession()],
    ['missing session hash', token, { ...activeSession(), csrfHash: null }],
    ['revoked session', token, { ...activeSession(), revokedAt: new Date() }],
    ['expired session', token, { ...activeSession(), expiresAt: new Date(Date.now() - 1) }],
  ])('fails closed for a %s without mutating the session', async (_case, presented, session) => {
    const { service, sessions } = subject();
    sessions.findOneBy.mockResolvedValue(session);

    await expect(service.getSessionCsrf('session-1', presented)).rejects.toMatchObject({
      code: 'CSRF_INVALID',
    });
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it('reuses only bounded public tokens and issues a replacement otherwise', () => {
    const { service, crypto } = subject();

    expect(service.getPublicCsrf(token)).toBe(token);
    expect(service.getPublicCsrf('invalid')).toBe('B'.repeat(32));
    expect(service.getPublicCsrf(undefined)).toBe('B'.repeat(32));
    expect(crypto.randomToken).toHaveBeenCalledTimes(2);
  });
});

describe('AuthService MFA policy', () => {
  it('creates an authenticated session directly when MFA is disabled by default', async () => {
    const { service, users, manager, audit } = subject();
    users.findOne.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'admin@example.gov.vn',
      username: 'admin',
      displayName: 'System Admin',
      role: 'system_admin',
      status: 'active',
      passwordHash: 'argon2id-hash',
      mfaEnabled: true,
      mustChangePassword: false,
      disabledAt: null,
      lockedUntil: null,
    });

    await expect(
      service.login(
        { login: 'admin', password: 'valid-password' },
        { requestId: '33333333-3333-4333-8333-333333333333', ip: '127.0.0.1' },
      ),
    ).resolves.toMatchObject({
      sessionKind: 'authenticated',
      data: {
        status: 'authenticated',
        mfaEnrollmentRequired: false,
        principal: { role: 'system_admin', mfaEnabled: false },
      },
    });
    expect(manager.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'authenticated' }),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login_succeeded' }),
    );
  });

  it('rejects MFA operations without touching persistence when MFA is disabled', async () => {
    const { service, dataSource } = subject();
    await expect(
      service.startMfaEnrollment('user-id', 'session-id', { requestId: 'request-id' }),
    ).rejects.toMatchObject({ status: 409, code: 'MFA_DISABLED' });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});

function activeSession() {
  return {
    csrfHash: tokenDigest,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };
}
