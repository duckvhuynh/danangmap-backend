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
    expect(validateEnvironment({ ...baseline, PORT: '4100', COOKIE_SECURE: 'true' })).toEqual(
      expect.objectContaining({ PORT: 4100, COOKIE_SECURE: true }),
    );
  });
});
