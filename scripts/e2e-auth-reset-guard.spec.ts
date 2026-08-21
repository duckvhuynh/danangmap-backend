import { assertE2eAuthResetAllowed } from './e2e-auth-reset-guard';

const allowedEnvironment = {
  DANANGMAP_E2E_AUTH_RESET: 'true',
  SEED_CROSSSTACK_FIXTURES: 'true',
  ALLOW_SEED: 'true',
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://danangmap:local-only@postgres:5432/danangmap',
  DATABASE_SSL: 'false',
};

describe('E2E auth reset guard', () => {
  it('allows only the explicit local cross-stack test seed', () => {
    expect(() => assertE2eAuthResetAllowed(allowedEnvironment)).not.toThrow();
  });

  it.each([
    ['missing reset opt-in', { DANANGMAP_E2E_AUTH_RESET: undefined }],
    ['missing seed permission', { ALLOW_SEED: undefined }],
    ['production environment', { NODE_ENV: 'production' }],
    ['missing cross-stack fixture marker', { SEED_CROSSSTACK_FIXTURES: undefined }],
    [
      'localhost database host',
      { DATABASE_URL: 'postgresql://danangmap:pass@localhost:5432/danangmap' },
    ],
    [
      'loopback database host',
      { DATABASE_URL: 'postgresql://danangmap:pass@127.0.0.1:5432/danangmap' },
    ],
    ['wrong database protocol', { DATABASE_URL: 'https://danangmap:pass@postgres:5432/danangmap' }],
    ['wrong database user', { DATABASE_URL: 'postgresql://operator:pass@postgres:5432/danangmap' }],
    ['SSL-enabled database config', { DATABASE_SSL: 'true' }],
    [
      'external database host',
      { DATABASE_URL: 'postgresql://user:pass@db.example.gov.vn/danangmap' },
    ],
    ['unexpected database name', { DATABASE_URL: 'postgresql://user:pass@postgres/production' }],
  ])('refuses %s', (_name, override) => {
    expect(() => assertE2eAuthResetAllowed({ ...allowedEnvironment, ...override })).toThrow(
      /E2E auth reset/u,
    );
  });
});
