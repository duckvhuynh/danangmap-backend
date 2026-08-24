import {
  DEVELOPMENT_PREAUTH_COOKIE,
  DEVELOPMENT_SESSION_COOKIE,
  PREAUTH_COOKIE,
  SESSION_COOKIE,
  preauthCookieName,
  sessionCookieName,
} from '../src/identity/auth.guards';

describe('environment-safe authentication cookie names', () => {
  it('keeps the __Host prefix only when Secure cookies are enabled', () => {
    expect(sessionCookieName(true)).toBe(SESSION_COOKIE);
    expect(preauthCookieName(true)).toBe(PREAUTH_COOKIE);
    expect(sessionCookieName(false)).toBe(DEVELOPMENT_SESSION_COOKIE);
    expect(preauthCookieName(false)).toBe(DEVELOPMENT_PREAUTH_COOKIE);
    expect(DEVELOPMENT_SESSION_COOKIE.startsWith('__Host-')).toBe(false);
    expect(DEVELOPMENT_PREAUTH_COOKIE.startsWith('__Host-')).toBe(false);
  });
});
