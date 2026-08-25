import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import Redis from 'ioredis';
import { E2E_PREAUTH_COOKIE, E2E_SESSION_COOKIE } from './auth-cookie.helper';

interface PgClientLike {
  connect(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

const { Client } = jest.requireActual<{
  Client: new (options: { connectionString: string }) => PgClientLike;
}>('pg');

const execFileAsync = promisify(execFile);
const allowedOrigin = 'http://localhost:3000';
const configuredToken = `bootstrap-${randomUUID()}-${randomUUID()}`;
const password = 'Fresh-System-Admin-2026!';

jest.setTimeout(120_000);

class CookieJar {
  private readonly values = new Map<string, string>();

  absorb(response: Response): void {
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator < 1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue.length === 0 || /max-age=0/i.test(value)) this.values.delete(name);
      else this.values.set(name, cookieValue);
    }
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  header(): string {
    return [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}

describe('first System Admin bootstrap against a fresh PostgreSQL database', () => {
  const sourceDatabaseUrl = process.env.DATABASE_URL;
  const databaseName = `danangmap_bootstrap_${randomUUID().replaceAll('-', '')}`;
  const apiPort = 4600 + Math.floor(Math.random() * 600);
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  let databaseUrl = '';
  let adminDatabaseUrl = '';
  let apiProcess: ChildProcess | undefined;

  beforeAll(async () => {
    if (!sourceDatabaseUrl) throw new Error('DATABASE_URL is required for bootstrap E2E');
    const parsed = new URL(sourceDatabaseUrl);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    parsed.pathname = '/postgres';
    adminDatabaseUrl = parsed.toString();

    const admin = new Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.end();
    await execFileAsync(
      process.execPath,
      ['node_modules/typeorm/cli.js', '-d', 'dist/src/database/data-source.js', 'migration:run'],
      { env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl } },
    );
    await cleanupBootstrapRateKeys();
  });

  afterAll(async () => {
    await stopApi();
    if (!adminDatabaseUrl) return;
    const admin = new Client({ connectionString: adminDatabaseUrl });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
    await cleanupBootstrapRateKeys();
  });

  it('is unavailable without a token, allows one concurrent winner, and continues through MFA', async () => {
    await startApi(undefined);
    const disabledStatus = await fetch(`${apiBaseUrl}/api/v1/auth/bootstrap/status`);
    expect(disabledStatus.status).toBe(200);
    await expect(disabledStatus.json()).resolves.toMatchObject({ data: { available: false } });
    const disabledJar = await csrfJar();
    const disabled = await bootstrapRequest(disabledJar, configuredToken);
    expect(disabled.status).toBe(503);
    await expect(disabled.json()).resolves.toMatchObject({ code: 'BOOTSTRAP_UNAVAILABLE' });
    await stopApi();

    await startApi(configuredToken);
    const availableStatus = await fetch(`${apiBaseUrl}/api/v1/auth/bootstrap/status`);
    await expect(availableStatus.json()).resolves.toMatchObject({ data: { available: true } });

    const publicJar = await csrfJar();
    const invalid = await bootstrapRequest(publicJar, 'B'.repeat(64));
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'BOOTSTRAP_TOKEN_INVALID' });

    const attempts = await Promise.all([
      bootstrapRequest(publicJar, configuredToken),
      bootstrapRequest(publicJar, configuredToken),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = attempts.find((response) => response.status === 201)!;
    const loser = attempts.find((response) => response.status === 409)!;
    await expect(loser.json()).resolves.toMatchObject({ code: 'BOOTSTRAP_ALREADY_COMPLETED' });
    const winnerBody = (await winner.json()) as Envelope<{
      status: string;
      mfaEnrollmentRequired: boolean;
    }>;
    expect(winnerBody.data).toMatchObject({
      status: 'mfa_required',
      mfaEnrollmentRequired: true,
    });
    publicJar.absorb(winner);
    expect(publicJar.get(E2E_PREAUTH_COOKIE)).toBeDefined();

    const replay = await bootstrapRequest(publicJar, configuredToken);
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: 'BOOTSTRAP_ALREADY_COMPLETED' });

    const enrollment = await postWithCsrf('/api/v1/auth/mfa/enroll', publicJar);
    expect(enrollment.status).toBe(200);
    const enrollmentBody = (await enrollment.json()) as Envelope<{ enrollmentUri: string }>;
    const secret = new URL(enrollmentBody.data.enrollmentUri).searchParams.get('secret');
    expect(secret).toBeTruthy();
    const confirmed = await postWithCsrf('/api/v1/auth/mfa/enroll/confirm', publicJar, {
      code: generateTotp(secret!),
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as Envelope<{
      principal: { role: string; mfaEnabled: boolean };
      recoveryCodes: string[];
    }>;
    expect(confirmedBody.data.principal).toMatchObject({
      role: 'system_admin',
      mfaEnabled: true,
    });
    expect(confirmedBody.data.recoveryCodes).toHaveLength(10);
    publicJar.absorb(confirmed);
    expect(publicJar.get(E2E_SESSION_COOKIE)).toBeDefined();

    const database = new Client({ connectionString: databaseUrl });
    await database.connect();
    const users = await database.query<{ count: string; role: string; mfa_enabled: boolean }>(
      `SELECT count(*) OVER()::text AS count,role,mfa_enabled FROM users`,
    );
    expect(users.rows).toEqual([
      expect.objectContaining({ count: '1', role: 'system_admin', mfa_enabled: true }),
    ]);
    const audit = await database.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action,metadata FROM audit_logs WHERE action LIKE 'auth.bootstrap_%' ORDER BY occurred_at`,
    );
    expect(audit.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'auth.bootstrap_system_admin_failed',
        'auth.bootstrap_system_admin_created',
      ]),
    );
    const auditText = JSON.stringify(audit.rows);
    expect(auditText).not.toContain(password);
    expect(auditText).not.toContain(configuredToken);
    expect(auditText).not.toContain(secret!);
    for (const recoveryCode of confirmedBody.data.recoveryCodes) {
      expect(auditText).not.toContain(recoveryCode);
    }
    await database.end();

    const completedStatus = await fetch(`${apiBaseUrl}/api/v1/auth/bootstrap/status`);
    await expect(completedStatus.json()).resolves.toMatchObject({ data: { available: false } });
  });

  async function startApi(token: string | undefined): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      PORT: String(apiPort),
      COOKIE_SECURE: process.env.API_COOKIE_SECURE ?? 'false',
    };
    if (token) env.INITIAL_ADMIN_BOOTSTRAP_TOKEN = token;
    else delete env.INITIAL_ADMIN_BOOTSTRAP_TOKEN;
    apiProcess = spawn(process.execPath, ['dist/apps/api/src/main.js'], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    apiProcess.stdout?.on('data', (chunk) => output.push(String(chunk)));
    apiProcess.stderr?.on('data', (chunk) => output.push(String(chunk)));
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (apiProcess.exitCode !== null) {
        throw new Error(`Bootstrap API exited early: ${output.join('')}`);
      }
      const live = await fetch(`${apiBaseUrl}/health/live`).catch(() => undefined);
      if (live?.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Bootstrap API did not become live: ${output.join('')}`);
  }

  async function stopApi(): Promise<void> {
    const child = apiProcess;
    apiProcess = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const stopped = await waitForExit(child, 5_000);
    if (!stopped && child.exitCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child, 2_000);
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.removeAllListeners();
  }

  async function csrfJar(): Promise<CookieJar> {
    const jar = new CookieJar();
    const response = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
      headers: { Origin: allowedOrigin },
    });
    expect(response.status).toBe(200);
    jar.absorb(response);
    return jar;
  }

  function bootstrapRequest(jar: CookieJar, token: string): Promise<Response> {
    return fetch(`${apiBaseUrl}/api/v1/auth/bootstrap/system-admin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: allowedOrigin,
        Cookie: jar.header(),
        'X-CSRF-Token': jar.get('danangmap_csrf') ?? '',
        'X-Initial-Admin-Bootstrap-Token': token,
      },
      body: JSON.stringify({
        email: 'first-admin@example.gov.vn',
        username: 'first.admin',
        displayName: 'Quản trị hệ thống đầu tiên',
        password,
        passwordConfirmation: password,
      }),
    });
  }

  function postWithCsrf(
    path: string,
    jar: CookieJar,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        Origin: allowedOrigin,
        Cookie: jar.header(),
        'X-CSRF-Token': jar.get('danangmap_csrf') ?? '',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
});

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function cleanupBootstrapRateKeys(): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
  });
  await redis.connect();
  const keys = await redis.keys('{identity-rate}:bootstrap_system_admin:*');
  if (keys.length > 0) await redis.unlink(...keys);
  await redis.quit();
}

function generateTotp(secret: string, epochSeconds = Math.floor(Date.now() / 1_000)): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replaceAll('=', '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < key.length; index += 1) {
    key[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epochSeconds / 30)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}
