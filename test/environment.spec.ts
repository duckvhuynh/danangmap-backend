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
        TRUST_PROXY_HOPS: '1',
      }),
    ).toEqual(expect.objectContaining({ PORT: 4100, COOKIE_SECURE: true, TRUST_PROXY_HOPS: 1 }));
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
