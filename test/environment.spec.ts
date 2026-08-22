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
        ASYNC_PUBLICATION_ENABLED: false,
      }),
    );
  });

  it('keeps async publication disabled by default and validates bounded dispatcher settings', () => {
    expect(validateEnvironment(baseline).ASYNC_PUBLICATION_ENABLED).toBe(false);
    expect(
      validateEnvironment({
        ...baseline,
        ASYNC_PUBLICATION_ENABLED: 'true',
        PUBLICATION_DISPATCH_BATCH_SIZE: '100',
        PUBLICATION_OUTBOX_LEASE_SECONDS: '300',
        PUBLICATION_BUILD_BATCH_SIZE: '500',
        PUBLICATION_MAX_FEATURES: '1000000',
        PUBLICATION_MAX_VERTICES: '20000000',
      }),
    ).toEqual(
      expect.objectContaining({
        ASYNC_PUBLICATION_ENABLED: true,
        PUBLICATION_DISPATCH_BATCH_SIZE: 100,
        PUBLICATION_OUTBOX_LEASE_SECONDS: 300,
        PUBLICATION_BUILD_BATCH_SIZE: 500,
        PUBLICATION_MAX_FEATURES: 1_000_000,
        PUBLICATION_MAX_VERTICES: 20_000_000,
      }),
    );
    expect(() => validateEnvironment({ ...baseline, ASYNC_PUBLICATION_ENABLED: 'yes' })).toThrow(
      'ASYNC_PUBLICATION_ENABLED',
    );
    expect(() =>
      validateEnvironment({ ...baseline, PUBLICATION_DISPATCH_BATCH_SIZE: '101' }),
    ).toThrow('PUBLICATION_DISPATCH_BATCH_SIZE');
  });

  it('keeps publication recovery controls bounded and test-only', () => {
    expect(() => validateEnvironment({ ...baseline, PUBLICATION_BUILD_BATCH_SIZE: '501' })).toThrow(
      'PUBLICATION_BUILD_BATCH_SIZE',
    );
    expect(() =>
      validateEnvironment({
        ...baseline,
        NODE_ENV: 'development',
        PUBLICATION_TEST_FAILPOINT: 'after_batch_commit',
      }),
    ).toThrow('publication test controls are allowed only when NODE_ENV=test');
    expect(
      validateEnvironment({
        ...baseline,
        NODE_ENV: 'test',
        PUBLICATION_TEST_BARRIER: 'after_batch_commit',
      }).PUBLICATION_TEST_BARRIER,
    ).toBe('after_batch_commit');
    expect(() =>
      validateEnvironment({
        ...baseline,
        NODE_ENV: 'production',
        PUBLICATION_TEST_BARRIER: 'after_batch_commit',
      }),
    ).toThrow('publication test controls are allowed only when NODE_ENV=test');
  });

  it('refuses the admission-only async publication flag in production', () => {
    expect(() =>
      validateEnvironment({
        ...baseline,
        NODE_ENV: 'production',
        ASYNC_PUBLICATION_ENABLED: 'true',
      }),
    ).toThrow(
      'ASYNC_PUBLICATION_ENABLED: must remain false in production until frontend and exact E2E activation pass',
    );
    expect(
      validateEnvironment({
        ...baseline,
        NODE_ENV: 'production',
        ASYNC_PUBLICATION_ENABLED: 'false',
      }).ASYNC_PUBLICATION_ENABLED,
    ).toBe(false);
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

  it('requires a complete SMTP configuration and strict production transport security', () => {
    expect(() =>
      validateEnvironment({ ...baseline, SMTP_ENABLED: 'true', SMTP_HOST: 'smtp.example.vn' }),
    ).toThrow('Invalid environment configuration');
    expect(() =>
      validateEnvironment({
        ...baseline,
        NODE_ENV: 'production',
        SMTP_ENABLED: 'true',
        SMTP_HOST: 'smtp.example.vn',
        SMTP_FROM_ADDRESS: 'no-reply@example.vn',
        SMTP_TLS_MODE: 'none',
      }),
    ).toThrow('SMTP_TLS_MODE');
    expect(() =>
      validateEnvironment({ ...baseline, SMTP_FROM_NAME: 'DanangMap\r\nBcc: victim@example.vn' }),
    ).toThrow('SMTP_FROM_NAME');
  });
});
