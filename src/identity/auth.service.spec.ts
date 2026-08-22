jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verify: jest.fn(),
}));

import { AuthService } from './auth.service';

const token = 'A'.repeat(32);
const tokenDigest = '1'.repeat(64);

function subject() {
  const sessions = {
    findOneBy: jest.fn(),
    update: jest.fn(),
  };
  const crypto = {
    digest: jest.fn((value: string) => (value === token ? tokenDigest : '2'.repeat(64))),
    randomToken: jest.fn(() => 'B'.repeat(32)),
  };
  const service = new AuthService(
    {} as never,
    sessions as never,
    {} as never,
    {} as never,
    crypto as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, sessions, crypto };
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

function activeSession() {
  return {
    csrfHash: tokenDigest,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };
}
