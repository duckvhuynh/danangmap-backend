export const configuration = () => ({
  app: {
    environment: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 4000),
    version: process.env.APP_VERSION ?? '0.1.0',
    frontendOrigins: process.env.FRONTEND_ORIGINS ?? 'http://localhost:3000',
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    mfaTotpIssuer: process.env.MFA_TOTP_ISSUER ?? 'DanangMap',
    trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSsl: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    bucket: process.env.MINIO_BUCKET ?? 'danangmap',
  },
  geoService: {
    baseUrl: process.env.GEO_SERVICE_BASE_URL ?? '',
    authHeader: process.env.GEO_SERVICE_AUTH_HEADER || undefined,
    connectTimeoutMs: Number(process.env.GEO_SERVICE_CONNECT_TIMEOUT_MS ?? 2_000),
    totalTimeoutMs: Number(process.env.GEO_SERVICE_TOTAL_TIMEOUT_MS ?? 5_000),
    retryAttempts: Number(process.env.GEO_SERVICE_RETRY_ATTEMPTS ?? 2),
    retryDelayMs: Number(process.env.GEO_SERVICE_RETRY_DELAY_MS ?? 100),
    breakerFailureThreshold: Number(process.env.GEO_SERVICE_BREAKER_FAILURE_THRESHOLD ?? 5),
    breakerOpenMs: Number(process.env.GEO_SERVICE_BREAKER_OPEN_MS ?? 30_000),
  },
});
