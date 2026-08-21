import { createHmac, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import AppDataSource from '../src/database/data-source';
import { PUBLICATION_QUEUE } from '../src/jobs/jobs.constants';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
const frontendOrigin = 'http://localhost:3000';
const mfaSecret = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const users = {
  systemAdmin: {
    id: '00000000-0000-4000-8000-000000000001',
    login: 'admin',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-2026!',
  },
  editor: {
    id: '00000000-0000-4000-8000-000000000002',
    login: 'editor',
    password: process.env.SEED_EDITOR_PASSWORD ?? 'ChangeMe-Editor-2026!',
  },
  reviewer: {
    id: '00000000-0000-4000-8000-000000000003',
    login: 'reviewer',
    password: process.env.SEED_REVIEWER_PASSWORD ?? 'ChangeMe-Reviewer-2026!',
  },
  publisher: {
    id: '00000000-0000-4000-8000-000000000004',
    login: 'publisher',
    password: process.env.SEED_PUBLISHER_PASSWORD ?? 'ChangeMe-Publisher-2026!',
  },
} as const;

interface Actor {
  id: string;
  cookie: string;
  csrf: string;
}

interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}

interface JobView {
  id: string;
  layerId: string;
  revisionId: string;
  status: string;
  phase: string;
  progress: { completedUnits: number; totalUnits: number | null; percent: number | null };
  failure: { code: string; userMessage: string; requestId: string; retryable: boolean } | null;
}

const describeAsync = process.env.ASYNC_PUBLICATION_ENABLED === 'true' ? describe : describe.skip;

describeAsync('durable publication admission HTTP E2E', () => {
  const startedAt = new Date();
  const groupId = randomUUID();
  const layerId = randomUUID();
  const revisionId = randomUUID();
  const failedJobId = randomUUID();
  let publisher: Actor;
  let actors: Actor[];
  let admittedJobId: string | null = null;
  let queue: Queue;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      `UPDATE user_mfa_methods SET last_used_time_step=NULL
       WHERE user_id=ANY($1::uuid[])`,
      [Object.values(users).map((user) => user.id)],
    );
    actors = await Promise.all([
      login(users.editor),
      login(users.reviewer),
      login(users.publisher),
      login(users.systemAdmin),
    ]);
    publisher = actors[2]!;
    queue = new Queue(PUBLICATION_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
      },
      prefix: 'danangmap:q',
    });
    await AppDataSource.query(
      `INSERT INTO layer_groups(id,slug,title) VALUES($1,$2,'Async publication E2E')`,
      [groupId, `async-publication-${groupId}`],
    );
    await AppDataSource.query(
      `INSERT INTO layers(id,slug,group_id,created_by) VALUES($1,$2,$3,$4)`,
      [layerId, `async-publication-${layerId}`, groupId, users.editor.id],
    );
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
         id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,
         created_by,submitted_at,approved_at
       ) VALUES($1,$2,1,'approved','Async publication E2E','point','{point}',$3,now(),now())`,
      [revisionId, layerId, users.editor.id],
    );
    await AppDataSource.query(
      `INSERT INTO revision_participants(revision_id,user_id,participation_type)
       VALUES($1,$2,'edit'),($1,$3,'review')`,
      [revisionId, users.editor.id, users.reviewer.id],
    );
    await AppDataSource.query(
      `INSERT INTO publication_jobs(
         id,layer_id,revision_id,requested_by,request_id,client_intent,release_note,
         revision_lock_version,revision_schema_version,revision_fingerprint,status,phase,
         failure_code,failure_correlation_id,finished_at
       ) VALUES($1,$2,$3,$4,$5,'desktop','Historical redaction canary token',$6,$7,$8,
         'failed','failed','PUBLICATION_DEPENDENCY_UNAVAILABLE',$9,now())`,
      [
        failedJobId,
        layerId,
        revisionId,
        users.publisher.id,
        randomUUID(),
        1,
        1,
        'd'.repeat(64),
        randomUUID(),
      ],
    );
    await AppDataSource.query(
      `INSERT INTO publication_job_outbox(
         publication_job_id,status,attempts,dispatched_at
       ) VALUES($1,'dispatched',1,now())`,
      [failedJobId],
    );
  });

  afterAll(async () => {
    for (const jobId of [admittedJobId, failedJobId].filter(Boolean) as string[]) {
      const job = await queue.getJob(`publication-${jobId}`).catch(() => undefined);
      await job?.remove().catch(() => undefined);
    }
    await queue.close();
    if (AppDataSource.isInitialized) {
      await AppDataSource.transaction(async (manager) => {
        await manager.query(`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable`);
        await manager.query(
          `ALTER TABLE workflow_events DISABLE TRIGGER trg_workflow_events_immutable`,
        );
        await manager.query(
          `DELETE FROM command_receipts
           WHERE actor_id=ANY($1::uuid[]) AND created_at >= $2`,
          [Object.values(users).map((user) => user.id), startedAt],
        );
        await manager.query(
          `DELETE FROM audit_logs
           WHERE id IN (SELECT audit_id FROM audit_layer_scopes WHERE layer_id=$1)`,
          [layerId],
        );
        await manager.query(`DELETE FROM publication_jobs WHERE layer_id=$1`, [layerId]);
        await manager.query(`DELETE FROM workflow_events WHERE revision_id=$1`, [revisionId]);
        await manager.query(`DELETE FROM revision_participants WHERE revision_id=$1`, [revisionId]);
        await manager.query(`DELETE FROM layer_revisions WHERE id=$1`, [revisionId]);
        await manager.query(`DELETE FROM layers WHERE id=$1`, [layerId]);
        await manager.query(`DELETE FROM layer_groups WHERE id=$1`, [groupId]);
        await manager.query(
          `DELETE FROM admin_sessions WHERE user_id=ANY($1::uuid[]) AND created_at >= $2`,
          [Object.values(users).map((user) => user.id), startedAt],
        );
        await manager.query(
          `UPDATE user_mfa_methods SET last_used_time_step=NULL
           WHERE user_id=ANY($1::uuid[])`,
          [Object.values(users).map((user) => user.id)],
        );
        await manager.query(
          `ALTER TABLE workflow_events ENABLE TRIGGER trg_workflow_events_immutable`,
        );
        await manager.query(`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable`);
      });
      await AppDataSource.destroy();
    }
  });

  it('rejects missing/non-desktop intent before every durable side effect', async () => {
    const before = await mutationState();
    await expectProblem(
      post(publisher, `/api/v1/admin/revisions/${revisionId}:publish`, {
        releaseNote: 'Missing desktop intent',
      }),
      400,
      'BAD_REQUEST',
    );
    await expectProblem(
      post(publisher, `/api/v1/admin/revisions/${revisionId}:publish`, {
        releaseNote: 'Mobile intent is forbidden',
        clientIntent: 'mobile',
      }),
      400,
      'VALIDATION_FAILED',
    );
    expect(await mutationState()).toEqual(before);
  });

  it('enforces role and separation-of-duties admission without stranded receipts', async () => {
    const body = { releaseNote: 'Role matrix', clientIntent: 'desktop' };
    for (const actor of [actors[0]!, actors[1]!, actors[3]!]) {
      await expectProblem(
        post(actor, `/api/v1/admin/revisions/${revisionId}:publish`, body),
        403,
        'ROLE_FORBIDDEN',
      );
    }
    const before = await mutationState();
    await AppDataSource.query(
      `INSERT INTO revision_participants(revision_id,user_id,participation_type)
       VALUES($1,$2,'edit')`,
      [revisionId, users.publisher.id],
    );
    await expectProblem(
      post(publisher, `/api/v1/admin/revisions/${revisionId}:publish`, body),
      403,
      'SEPARATION_OF_DUTIES',
    );
    await AppDataSource.query(
      `DELETE FROM revision_participants
       WHERE revision_id=$1 AND user_id=$2 AND participation_type='edit'`,
      [revisionId, users.publisher.id],
    );
    expect(await mutationState()).toEqual(before);
  });

  it('commits one queued job/outbox and replays the stable original 202 contract', async () => {
    const key = randomUUID();
    const body = {
      releaseNote: 'Durable queued publication',
      clientIntent: 'desktop',
    };
    const response = await post(
      publisher,
      `/api/v1/admin/revisions/${revisionId}:publish`,
      body,
      key,
    );
    expect(response.status).toBe(202);
    const etag = requiredHeader(response, 'etag');
    expect(requiredHeader(response, 'location')).toMatch(
      /^\/api\/v1\/admin\/publication-jobs\/[0-9a-f-]{36}$/,
    );
    expect(Number(requiredHeader(response, 'retry-after'))).toBeGreaterThanOrEqual(1);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const job = (await json<Envelope<JobView>>(response)).data;
    admittedJobId = job.id;
    expect(job).toMatchObject({
      layerId,
      revisionId,
      status: 'queued',
      phase: 'queued',
      progress: { completedUnits: 0, totalUnits: null, percent: null },
      failure: null,
    });

    const replay = await post(
      publisher,
      `/api/v1/admin/revisions/${revisionId}:publish`,
      body,
      key,
    );
    expect(replay.status).toBe(202);
    expect(requiredHeader(replay, 'etag')).toBe(etag);
    expect((await json<Envelope<JobView>>(replay)).data).toEqual(job);
    await expectProblem(
      post(
        publisher,
        `/api/v1/admin/revisions/${revisionId}:publish`,
        { ...body, releaseNote: 'Mismatched reuse' },
        key,
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );

    const rows = (await AppDataSource.query(
      `SELECT job.client_intent,job.status,job.phase,job.requested_by,
              revision.status AS revision_status,revision.lock_version,
              (SELECT count(*)::integer FROM publication_job_outbox outbox
               WHERE outbox.publication_job_id=job.id) AS outbox_count,
              (SELECT count(*)::integer FROM workflow_events event
               WHERE event.revision_id=job.revision_id AND event.to_status='publishing') AS event_count,
              (SELECT count(*)::integer FROM audit_logs audit
               WHERE audit.action='publication.queued' AND audit.resource_id=job.revision_id) AS audit_count
       FROM publication_jobs job
       JOIN layer_revisions revision ON revision.id=job.revision_id WHERE job.id=$1`,
      [job.id],
    )) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      client_intent: 'desktop',
      status: 'queued',
      phase: 'queued',
      requested_by: users.publisher.id,
      revision_status: 'publishing',
      lock_version: 2,
      outbox_count: 1,
      event_count: 1,
      audit_count: 1,
    });
    const audits = (await AppDataSource.query(
      `SELECT metadata FROM audit_logs WHERE action='publication.queued' AND resource_id=$1`,
      [revisionId],
    )) as Array<{ metadata: Record<string, unknown> }>;
    expect(audits[0]?.metadata).toEqual({
      jobId: job.id,
      layerId,
      revisionId,
      clientIntent: 'desktop',
    });
    expect(JSON.stringify(audits)).not.toContain(body.releaseNote);
  });

  it('serves role-readable ETag detail and bounded cursor pages with redacted failures', async () => {
    for (const actor of actors) {
      const response = await get(actor, `/api/v1/admin/publication-jobs/${admittedJobId}`);
      expect(response.status).toBe(200);
      const etag = requiredHeader(response, 'etag');
      const conditional = await get(actor, `/api/v1/admin/publication-jobs/${admittedJobId}`, etag);
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe('');
    }

    const first = await get(actors[0]!, `/api/v1/admin/layers/${layerId}/publication-jobs?limit=1`);
    expect(first.status).toBe(200);
    const firstBody = (
      await json<Envelope<{ items: JobView[]; nextCursor: string; hasMore: boolean }>>(first)
    ).data;
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    const second = await get(
      actors[0]!,
      `/api/v1/admin/layers/${layerId}/publication-jobs?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    const secondItems = (await json<Envelope<{ items: JobView[] }>>(second)).data.items;
    expect(secondItems).toHaveLength(1);
    expect(secondItems[0]?.id).not.toBe(firstBody.items[0]?.id);

    const failed = await get(actors[1]!, `/api/v1/admin/publication-jobs/${failedJobId}`);
    const failedBody = (await json<Envelope<JobView>>(failed)).data;
    expect(failedBody.failure).toMatchObject({
      code: 'PUBLICATION_DEPENDENCY_UNAVAILABLE',
      userMessage: 'Dịch vụ công bố đang tạm thời gián đoạn.',
      retryable: true,
    });
    expect(JSON.stringify(failedBody)).not.toContain('Historical redaction canary token');
    await expectProblem(
      get(actors[0]!, `/api/v1/admin/layers/${layerId}/publication-jobs?cursor=not-json`),
      400,
      'VALIDATION_FAILED',
    );
  });

  async function mutationState() {
    const rows = (await AppDataSource.query(
      `SELECT revision.status,revision.lock_version,
              (SELECT count(*)::integer FROM publication_jobs job
               WHERE job.layer_id=$1 AND job.id<>$3) AS job_count,
              (SELECT count(*)::integer FROM publication_job_outbox outbox
               JOIN publication_jobs job ON job.id=outbox.publication_job_id
               WHERE job.layer_id=$1 AND job.id<>$3) AS outbox_count,
              (SELECT count(*)::integer FROM workflow_events event
               WHERE event.revision_id=$2 AND event.to_status='publishing') AS event_count,
              (SELECT count(*)::integer FROM audit_logs audit
               WHERE audit.resource_id=$2 AND audit.action='publication.queued') AS audit_count,
              (SELECT count(*)::integer FROM command_receipts receipt
               WHERE receipt.actor_id=$4 AND receipt.operation='revision.publish'
                 AND receipt.created_at >= $5) AS receipt_count
       FROM layer_revisions revision WHERE revision.id=$2`,
      [layerId, revisionId, failedJobId, users.publisher.id, startedAt],
    )) as Array<Record<string, unknown>>;
    return rows[0];
  }
});

async function get(actor: Actor, path: string, ifNoneMatch?: string) {
  return fetch(`${apiBaseUrl}${path}`, {
    headers: { Cookie: actor.cookie, ...(ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}) },
  });
}

async function post(
  actor: Actor,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey = randomUUID(),
) {
  return fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: actor.cookie,
      Origin: frontendOrigin,
      'X-CSRF-Token': actor.csrf,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function expectProblem(responsePromise: Promise<Response>, status: number, code: string) {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ status, code });
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function login(user: (typeof users)[keyof typeof users]): Promise<Actor> {
  const csrfResponse = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`);
  expect(csrfResponse.status).toBe(200);
  const csrf = (await json<Envelope<{ csrfToken: string }>>(csrfResponse)).data.csrfToken;
  const publicCsrfCookie = cookieValue(csrfResponse, 'danangmap_csrf');
  const loginResponse = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `danangmap_csrf=${publicCsrfCookie}`,
      Origin: frontendOrigin,
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify({ login: user.login, password: user.password }),
  });
  expect(loginResponse.status).toBe(200);
  const preauth = cookieValue(loginResponse, '__Host-danangmap_preauth');
  const preauthCsrf = cookieValue(loginResponse, 'danangmap_csrf');
  const verify = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `__Host-danangmap_preauth=${preauth}; danangmap_csrf=${preauthCsrf}`,
      Origin: frontendOrigin,
      'X-CSRF-Token': preauthCsrf,
    },
    body: JSON.stringify({ method: 'totp', code: totp(mfaSecret) }),
  });
  expect(verify.status).toBe(200);
  const session = cookieValue(verify, '__Host-danangmap_session');
  const sessionCsrf = cookieValue(verify, 'danangmap_csrf');
  const stableCsrf = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: {
      Cookie: `__Host-danangmap_session=${session}; danangmap_csrf=${sessionCsrf}`,
    },
  });
  expect(stableCsrf.status).toBe(200);
  const token = (await json<Envelope<{ csrfToken: string }>>(stableCsrf)).data.csrfToken;
  return {
    id: user.id,
    cookie: `__Host-danangmap_session=${session}; danangmap_csrf=${token}`,
    csrf: token,
  };
}

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  if (!match?.[1]) throw new Error(`Missing ${name}`);
  return match[1];
}

function totp(secret: string, epoch = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epoch / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary =
    ((digest[offset]! & 127) << 24) |
    ((digest[offset + 1]! & 255) << 16) |
    ((digest[offset + 2]! & 255) << 8) |
    (digest[offset + 3]! & 255);
  return String(binary % 1_000_000).padStart(6, '0');
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.toUpperCase().replaceAll('=', '')) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid Base32');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}
