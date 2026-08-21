import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_VERSION: z.string().min(1).default('0.1.0'),
  DATABASE_URL: z.string().startsWith('postgresql://'),
  DATABASE_SSL: booleanString,
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().optional(),
  MINIO_ENDPOINT: z.string().min(1).default('localhost'),
  MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  MINIO_USE_SSL: booleanString,
  MINIO_ACCESS_KEY: z.string().min(3),
  MINIO_SECRET_KEY: z.string().min(8),
  MINIO_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  SESSION_PEPPER: z.string().min(32),
  FIELD_ENCRYPTION_KEY: z.string().min(32),
  FRONTEND_ORIGINS: z.string().min(1),
  COOKIE_SECURE: booleanString,
  MFA_TOTP_ISSUER: z.string().trim().min(1).max(100).default('DanangMap'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  GEO_SERVICE_BASE_URL: z.union([z.literal(''), z.string().url()]).default(''),
  GEO_SERVICE_AUTH_HEADER: z.string().optional(),
  GEO_SERVICE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(250).max(5_000).default(2_000),
  GEO_SERVICE_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(500).max(10_000).default(5_000),
  GEO_SERVICE_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(2),
  GEO_SERVICE_RETRY_DELAY_MS: z.coerce.number().int().min(0).max(1_000).default(100),
  GEO_SERVICE_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(5),
  GEO_SERVICE_BREAKER_OPEN_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${errors}`);
  }
  return result.data;
}

export function frontendOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);
}
