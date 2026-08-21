import { validateEnvironment } from '../src/config/environment';

describe('environment validation', () => {
  const baseline = {
    DATABASE_URL: 'postgresql://user:password@localhost:5432/danangmap',
    MINIO_ACCESS_KEY: 'danangmap',
    MINIO_SECRET_KEY: 'a-secure-local-secret',
    MINIO_BUCKET: 'danangmap',
    SESSION_PEPPER: '12345678901234567890123456789012',
    FIELD_ENCRYPTION_KEY: '12345678901234567890123456789012',
    FRONTEND_ORIGINS: 'http://localhost:3000',
  };

  it('fails fast when required secrets are missing', () => {
    expect(() => validateEnvironment({ DATABASE_URL: baseline.DATABASE_URL })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('normalizes typed configuration values', () => {
    expect(
      validateEnvironment({
        ...baseline,
        PORT: '4100',
        COOKIE_SECURE: 'true',
        GEO_SERVICE_RETRY_ATTEMPTS: '3',
        GEO_SERVICE_BREAKER_FAILURE_THRESHOLD: '10',
        TRUST_PROXY_HOPS: '1',
      }),
    ).toEqual(
      expect.objectContaining({
        PORT: 4100,
        COOKIE_SECURE: true,
        GEO_SERVICE_RETRY_ATTEMPTS: 3,
        GEO_SERVICE_BREAKER_FAILURE_THRESHOLD: 10,
        TRUST_PROXY_HOPS: 1,
      }),
    );
  });

  it('rejects unsafe Geo Service retry and breaker settings', () => {
    expect(() => validateEnvironment({ ...baseline, GEO_SERVICE_RETRY_ATTEMPTS: '4' })).toThrow(
      'Invalid environment configuration',
    );
    expect(() => validateEnvironment({ ...baseline, GEO_SERVICE_BREAKER_OPEN_MS: '999' })).toThrow(
      'Invalid environment configuration',
    );
  });

  it('keeps proxy trust off by default and rejects an unbounded hop count', () => {
    expect(validateEnvironment(baseline).TRUST_PROXY_HOPS).toBe(0);
    expect(() => validateEnvironment({ ...baseline, TRUST_PROXY_HOPS: '4' })).toThrow(
      'Invalid environment configuration',
    );
  });
});
