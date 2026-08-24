import { preauthCookieName, sessionCookieName } from '../src/identity/auth.guards';

const apiCookieSecure =
  (process.env.API_COOKIE_SECURE ?? process.env.COOKIE_SECURE ?? 'false').toLowerCase() === 'true';

export const E2E_PREAUTH_COOKIE = preauthCookieName(apiCookieSecure);
export const E2E_SESSION_COOKIE = sessionCookieName(apiCookieSecure);
