export function assertE2eAuthResetAllowed(environment: NodeJS.ProcessEnv): void {
  if (
    environment.DANANGMAP_E2E_AUTH_RESET !== 'true' ||
    environment.SEED_CROSSSTACK_FIXTURES !== 'true' ||
    environment.ALLOW_SEED !== 'true' ||
    environment.NODE_ENV !== 'test'
  ) {
    throw new Error('E2E auth reset requires the explicit local test-seed guard flags');
  }

  let databaseUrl: URL;
  try {
    databaseUrl = new URL(environment.DATABASE_URL ?? '');
  } catch {
    throw new Error('E2E auth reset requires a valid local DATABASE_URL');
  }
  if (
    databaseUrl.protocol !== 'postgresql:' ||
    databaseUrl.hostname !== 'postgres' ||
    databaseUrl.port !== '5432' ||
    databaseUrl.username !== 'danangmap' ||
    databaseUrl.pathname !== '/danangmap' ||
    databaseUrl.search !== '' ||
    databaseUrl.hash !== '' ||
    environment.DATABASE_SSL !== 'false'
  ) {
    throw new Error('E2E auth reset refuses targets outside the exact harness database');
  }
}
