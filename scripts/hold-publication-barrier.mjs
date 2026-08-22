import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const schemaVersion = 1;
const databaseUrl = required('DATABASE_URL');
const phaseDirectory = resolve(required('DANANGMAP_PHASE_DIRECTORY'));
const runNonce = required('DANANGMAP_RUN_NONCE');
const jobId = required('DANANGMAP_PUBLICATION_JOB_ID');

if (!/^[a-z0-9-]{16,128}$/u.test(runNonce)) throw new Error('Invalid durable phase run nonce.');
if (!uuid(jobId)) throw new Error('Invalid durable publication job id.');

await mkdir(phaseDirectory, { recursive: true });
const client = new Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  query_timeout: 35_000,
  application_name: 'danangmap-publication-test-barrier',
});
const barrierKey = `danangmap:publication:test:after_batch_commit:${jobId}`;
let shuttingDown = false;
let lockHeld = false;

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (lockHeld) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [barrierKey]);
      lockHeld = false;
    }
    await atomicJson('barrier-released.json', {
      schemaVersion,
      runNonce,
      jobId,
      barrier: 'after_batch_commit',
      releasedAt: new Date().toISOString(),
    });
  } finally {
    await client.end().catch(() => undefined);
    process.exit(exitCode);
  }
}

process.once('SIGTERM', () => void shutdown(0));
process.once('SIGINT', () => void shutdown(0));
client.once('error', () => void shutdown(1));

await client.connect();
await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [barrierKey]);
lockHeld = true;
await atomicJson('barrier-ready.json', {
  schemaVersion,
  runNonce,
  jobId,
  barrier: 'after_batch_commit',
  acquiredAt: new Date().toISOString(),
});

await new Promise(() => undefined);

async function atomicJson(name, value) {
  const target = resolve(phaseDirectory, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, target);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function uuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
