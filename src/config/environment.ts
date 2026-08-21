import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const trueBooleanString = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalEmail = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.email().optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    APP_VERSION: z.string().min(1).default('0.1.0'),
    DATABASE_URL: z.string().startsWith('postgresql://'),
    DATABASE_SSL: booleanString,
    REDIS_HOST: z.string().min(1).default('localhost'),
    REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
    REDIS_PASSWORD: z.string().optional(),
    ASYNC_PUBLICATION_ENABLED: booleanString,
    PUBLICATION_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
    PUBLICATION_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    PUBLICATION_OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
    PUBLICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
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
    SMTP_ENABLED: booleanString,
    MAIL_DELIVERY_REQUIRED: booleanString,
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_TLS_MODE: z.enum(['implicit', 'starttls', 'opportunistic', 'none']).default('starttls'),
    SMTP_REJECT_UNAUTHORIZED: trueBooleanString,
    SMTP_USERNAME: optionalString,
    SMTP_PASSWORD: optionalString,
    SMTP_FROM_NAME: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\r\n]+$/)
      .default('DanangMap'),
    SMTP_FROM_ADDRESS: optionalEmail,
    SMTP_REPLY_TO_ADDRESS: optionalEmail,
    SMTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
    SMTP_GREETING_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
    SMTP_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    SMTP_POOL_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(5).default(2),
    SMTP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(60),
    SMTP_PER_RECIPIENT_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
    MAIL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
    SMTP_PROBE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    MAIL_CLAIM_LEASE_SECONDS: z.coerce.number().int().min(15).max(300).default(60),
    MAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    MAIL_BACKOFF_BASE_SECONDS: z.coerce.number().int().min(1).max(900).default(30),
    MAIL_BACKOFF_MAX_SECONDS: z.coerce.number().int().min(10).max(21_600).default(3_600),
    MAIL_BACKOFF_JITTER_PERCENT: z.coerce.number().int().min(0).max(50).default(20),
    MAIL_FAILED_PAYLOAD_RETENTION_HOURS: z.coerce.number().int().min(1).max(72).default(24),
    MAIL_WORKER_HEARTBEAT_STALE_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && value.ASYNC_PUBLICATION_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['ASYNC_PUBLICATION_ENABLED'],
        message: 'must remain false in production until the durable builder is complete',
      });
    }
    if (value.MAIL_DELIVERY_REQUIRED && !value.SMTP_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['SMTP_ENABLED'],
        message: 'must be true when MAIL_DELIVERY_REQUIRED is true',
      });
    }
    if (value.SMTP_ENABLED && (!value.SMTP_HOST || !value.SMTP_FROM_ADDRESS)) {
      context.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST and SMTP_FROM_ADDRESS are required when SMTP is enabled',
      });
    }
    if (Boolean(value.SMTP_USERNAME) !== Boolean(value.SMTP_PASSWORD)) {
      context.addIssue({
        code: 'custom',
        path: ['SMTP_PASSWORD'],
        message: 'SMTP_USERNAME and SMTP_PASSWORD must be configured together',
      });
    }
    if (value.MAIL_BACKOFF_MAX_SECONDS < value.MAIL_BACKOFF_BASE_SECONDS) {
      context.addIssue({
        code: 'custom',
        path: ['MAIL_BACKOFF_MAX_SECONDS'],
        message: 'must be greater than or equal to MAIL_BACKOFF_BASE_SECONDS',
      });
    }
    if (
      value.NODE_ENV === 'production' &&
      value.SMTP_ENABLED &&
      !['implicit', 'starttls'].includes(value.SMTP_TLS_MODE)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SMTP_TLS_MODE'],
        message: 'must be implicit or starttls in production',
      });
    }
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
