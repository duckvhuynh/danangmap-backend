import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import AppDataSource from '../src/database/data-source';
import { PUBLICATION_BUILD_JOB, PUBLICATION_QUEUE } from '../src/jobs/jobs.constants';
import { PublicationJobRepository } from '../src/publications/publication-job.repository';
import { PublicationOutboxService } from '../src/publications/publication-outbox.service';
import { PublicationWorkerRepository } from '../src/publications/publication-worker.repository';

jest.setTimeout(60_000);

describe('durable publication outbox with real PostgreSQL and Redis', () => {
  const userId = randomUUID();
  const groupId = randomUUID();
  const fixtureIds: Array<{ layerId: string; revisionId: string; jobId: string }> = [];
  let queue: Queue;
  let service: PublicationOutboxService;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      `INSERT INTO users(
         id,email,email_normalized,username,username_normalized,display_name,role,status,password_hash
       ) VALUES($1,$2,$2,$3,$3,'Publication outbox','publisher','active','test-hash')`,
      [userId, `publication-outbox-${userId}@example.vn`, `publication_${userId}`],
    );
    await AppDataSource.query(
      `INSERT INTO layer_groups(id,slug,title) VALUES($1,$2,'Publication outbox group')`,
      [groupId, `publication-outbox-${groupId}`],
    );
    queue = new Queue(PUBLICATION_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        connectTimeout: 5_000,
      },
      prefix: 'danangmap:q',
    });
    service = new PublicationOutboxService(
      queue,
      new PublicationJobRepository(AppDataSource),
      new ConfigService({
        publication: {
          asyncEnabled: true,
          dispatchIntervalMs: 60_000,
          dispatchBatchSize: 25,
          outboxLeaseSeconds: 15,
          maxAttempts: 5,
          retryBackoffMs: 1_000,
        },
      }),
    );
  });

  afterAll(async () => {
    for (const fixture of fixtureIds) {
      const queued = await queue.getJob(`publication-${fixture.jobId}`).catch(() => undefined);
      await queued?.remove().catch(() => undefined);
    }
    await queue?.close();
    if (AppDataSource.isInitialized) {
      for (const fixture of fixtureIds) {
        await AppDataSource.query(`DELETE FROM publication_jobs WHERE id=$1`, [fixture.jobId]);
        await AppDataSource.query(`DELETE FROM layer_revisions WHERE id=$1`, [fixture.revisionId]);
        await AppDataSource.query(`DELETE FROM layers WHERE id=$1`, [fixture.layerId]);
      }
      await AppDataSource.query(`DELETE FROM layer_groups WHERE id=$1`, [groupId]);
      await AppDataSource.query(`DELETE FROM users WHERE id=$1`, [userId]);
      await AppDataSource.destroy();
    }
  });

  it('rotates the durable reconciliation cursor beyond the oldest bounded prefix', async () => {
    const repository = new PublicationJobRepository(AppDataSource);
    const fairService = new PublicationOutboxService(
      queue,
      repository,
      new ConfigService({
        publication: {
          asyncEnabled: true,
          dispatchIntervalMs: 60_000,
          dispatchBatchSize: 1,
          outboxLeaseSeconds: 15,
          maxAttempts: 5,
          retryBackoffMs: 1_000,
        },
      }),
    );
    await AppDataSource.query(
      `UPDATE publication_worker_state
       SET reconciliation_cursor_available_at=NULL,reconciliation_cursor_created_at=NULL,
           reconciliation_cursor_job_id=NULL WHERE id=1`,
    );
    const fairnessFixtures = [];
    for (let index = 0; index < 6; index += 1) {
      const fixture = await createFixture();
      fairnessFixtures.push(fixture);
      await queue.add(
        PUBLICATION_BUILD_JOB,
        { publicationJobId: fixture.jobId, payloadVersion: 1 },
        { jobId: `publication-${fixture.jobId}`, removeOnComplete: false, removeOnFail: false },
      );
    }
    const outsideFirstPrefix = fairnessFixtures.at(-1)!;
    await (await queue.getJob(`publication-${outsideFirstPrefix.jobId}`))!.remove();

    await fairService.dispatchOnce();
    expect(await queue.getJob(`publication-${outsideFirstPrefix.jobId}`)).toBeUndefined();
    await fairService.dispatchOnce();
    expect(await queue.getJob(`publication-${outsideFirstPrefix.jobId}`)).toBeDefined();

    for (const fixture of fairnessFixtures) {
      await (await queue.getJob(`publication-${fixture.jobId}`))?.remove();
      await AppDataSource.query(`DELETE FROM publication_jobs WHERE id=$1`, [fixture.jobId]);
      await AppDataSource.query(`DELETE FROM layer_revisions WHERE id=$1`, [fixture.revisionId]);
      await AppDataSource.query(`DELETE FROM layers WHERE id=$1`, [fixture.layerId]);
      const fixtureIndex = fixtureIds.findIndex((candidate) => candidate.jobId === fixture.jobId);
      if (fixtureIndex >= 0) fixtureIds.splice(fixtureIndex, 1);
    }
  });

  it('does not starve a delayed retry behind the cursor while newer jobs keep arriving', async () => {
    const repository = new PublicationJobRepository(AppDataSource);
    const fairService = new PublicationOutboxService(
      queue,
      repository,
      new ConfigService({
        publication: {
          asyncEnabled: true,
          dispatchIntervalMs: 60_000,
          dispatchBatchSize: 1,
          outboxLeaseSeconds: 15,
          maxAttempts: 5,
          retryBackoffMs: 1_000,
        },
      }),
    );
    await AppDataSource.query(
      `UPDATE publication_worker_state
       SET reconciliation_cursor_available_at=NULL,reconciliation_cursor_created_at=NULL,
           reconciliation_cursor_job_id=NULL WHERE id=1`,
    );

    const delayed = await createFixture();
    await AppDataSource.query(
      `UPDATE publication_jobs
       SET available_at=now()+interval '1 hour',lock_version=lock_version+1 WHERE id=$1`,
      [delayed.jobId],
    );
    await markOutboxDispatched(delayed.jobId);

    const firstPage = [];
    for (let index = 0; index < 4; index += 1) {
      const fixture = await createFixture();
      firstPage.push(fixture);
      await markOutboxDispatched(fixture.jobId);
      await queue.add(
        PUBLICATION_BUILD_JOB,
        { publicationJobId: fixture.jobId, payloadVersion: 1 },
        { jobId: `publication-${fixture.jobId}`, removeOnComplete: false, removeOnFail: false },
      );
    }
    await fairService.dispatchOnce();
    expect(await queue.getJob(`publication-${delayed.jobId}`)).toBeUndefined();

    await AppDataSource.query(
      `UPDATE publication_jobs SET available_at=now(),lock_version=lock_version+1 WHERE id=$1`,
      [delayed.jobId],
    );
    const newer = [];
    for (let index = 0; index < 4; index += 1) {
      const fixture = await createFixture();
      newer.push(fixture);
      await markOutboxDispatched(fixture.jobId);
      await queue.add(
        PUBLICATION_BUILD_JOB,
        { publicationJobId: fixture.jobId, payloadVersion: 1 },
        { jobId: `publication-${fixture.jobId}`, removeOnComplete: false, removeOnFail: false },
      );
    }
    await fairService.dispatchOnce();
    expect(await queue.getJob(`publication-${delayed.jobId}`)).toBeDefined();

    for (const fixture of [delayed, ...firstPage, ...newer]) {
      await (await queue.getJob(`publication-${fixture.jobId}`))?.remove();
      await AppDataSource.query(`DELETE FROM publication_jobs WHERE id=$1`, [fixture.jobId]);
      await AppDataSource.query(`DELETE FROM layer_revisions WHERE id=$1`, [fixture.revisionId]);
      await AppDataSource.query(`DELETE FROM layers WHERE id=$1`, [fixture.layerId]);
      const fixtureIndex = fixtureIds.findIndex((candidate) => candidate.jobId === fixture.jobId);
      if (fixtureIndex >= 0) fixtureIds.splice(fixtureIndex, 1);
    }
  });

  it('keeps dispatcher and worker failures independently observable', async () => {
    const repository = new PublicationJobRepository(AppDataSource);
    await AppDataSource.query(
      `UPDATE publication_worker_state
       SET worker_error_code='PUBLICATION_DEPENDENCY_UNAVAILABLE',dispatch_error_code=NULL
       WHERE id=1`,
    );
    await repository.updateDispatchState(null);
    expect(await componentErrors()).toEqual({
      dispatch_error_code: null,
      worker_error_code: 'PUBLICATION_DEPENDENCY_UNAVAILABLE',
    });

    await repository.updateDispatchState('PUBLICATION_QUEUE_UNAVAILABLE');
    await new PublicationWorkerRepository(AppDataSource).workerHeartbeat(null);
    expect(await componentErrors()).toEqual({
      dispatch_error_code: 'PUBLICATION_QUEUE_UNAVAILABLE',
      worker_error_code: null,
    });
    await AppDataSource.query(
      `UPDATE publication_worker_state SET dispatch_error_code=NULL,worker_error_code=NULL WHERE id=1`,
    );
  });

  it('dispatches once with deterministic safe job data and survives an acknowledgement replay', async () => {
    const fixture = await createFixture();
    await service.dispatchOnce();
    const bullJobId = `publication-${fixture.jobId}`;
    const job = await queue.getJob(bullJobId);
    expect(job).toBeDefined();
    expect(job?.name).toBe(PUBLICATION_BUILD_JOB);
    expect(job?.data).toEqual({ publicationJobId: fixture.jobId, payloadVersion: 1 });
    const state = (await AppDataSource.query(
      `SELECT status,attempts,lease_token,lease_owner,lease_expires_at,dispatched_at,last_error_code
       FROM publication_job_outbox WHERE publication_job_id=$1`,
      [fixture.jobId],
    )) as Array<Record<string, unknown>>;
    expect(state[0]).toMatchObject({
      status: 'dispatched',
      attempts: 1,
      lease_token: null,
      lease_owner: null,
      lease_expires_at: null,
      last_error_code: null,
    });
    expect(state[0]?.dispatched_at).toBeInstanceOf(Date);

    await service.dispatchOnce();
    expect((await queue.getJob(bullJobId))?.id).toBe(bullJobId);
    const replayState = (await AppDataSource.query(
      `SELECT attempts,dispatched_at FROM publication_job_outbox WHERE publication_job_id=$1`,
      [fixture.jobId],
    )) as Array<{ attempts: number; dispatched_at: Date }>;
    expect(replayState[0]?.attempts).toBe(1);
    expect(replayState[0]?.dispatched_at).toEqual(state[0]?.dispatched_at);
  });

  it('recreates a missing Bull job from the committed database row after Redis loss', async () => {
    const fixture = await createFixture();
    await service.dispatchOnce();
    const bullJobId = `publication-${fixture.jobId}`;
    const original = await queue.getJob(bullJobId);
    expect(original).toBeDefined();
    await original!.remove();
    expect(await queue.getJob(bullJobId)).toBeUndefined();

    await service.dispatchOnce();
    const recovered = await queue.getJob(bullJobId);
    expect(recovered?.data).toEqual({ publicationJobId: fixture.jobId, payloadVersion: 1 });
    const outbox = (await AppDataSource.query(
      `SELECT status,attempts,last_error_code FROM publication_job_outbox
       WHERE publication_job_id=$1`,
      [fixture.jobId],
    )) as Array<Record<string, unknown>>;
    expect(outbox[0]).toEqual({ status: 'dispatched', attempts: 1, last_error_code: null });
  });

  it('replaces a far-delayed Bull retry once the authoritative database job is ready', async () => {
    const fixture = await createFixture();
    await markOutboxDispatched(fixture.jobId);
    const bullJobId = `publication-${fixture.jobId}`;
    await queue.add(
      PUBLICATION_BUILD_JOB,
      { publicationJobId: fixture.jobId, payloadVersion: 1 },
      {
        jobId: bullJobId,
        attempts: 20,
        delay: 24 * 60 * 60 * 1_000,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    expect(await (await queue.getJob(bullJobId))!.getState()).toBe('delayed');

    await service.dispatchOnce();
    const reclaimed = await queue.getJob(bullJobId);
    expect(await reclaimed?.getState()).toBe('waiting');
    expect(reclaimed?.opts.attempts).toBe(1);
    expect(reclaimed?.opts.delay ?? 0).toBe(0);
  });

  it('recovers an expired dispatch lease without duplicating the durable job', async () => {
    const fixture = await createFixture();
    await AppDataSource.query(
      `UPDATE publication_job_outbox
       SET status='dispatching',attempts=1,lease_token=$2,lease_owner='crashed-dispatcher',
           lease_expires_at=now()-interval '1 second'
       WHERE publication_job_id=$1`,
      [fixture.jobId, randomUUID()],
    );
    await service.dispatchOnce();
    expect(await queue.getJob(`publication-${fixture.jobId}`)).toBeDefined();
    const outbox = (await AppDataSource.query(
      `SELECT status,attempts,lease_token FROM publication_job_outbox WHERE publication_job_id=$1`,
      [fixture.jobId],
    )) as Array<Record<string, unknown>>;
    expect(outbox[0]).toEqual({ status: 'dispatched', attempts: 2, lease_token: null });
  });

  async function createFixture() {
    const layerId = randomUUID();
    const revisionId = randomUUID();
    const jobId = randomUUID();
    fixtureIds.push({ layerId, revisionId, jobId });
    await AppDataSource.query(
      `INSERT INTO layers(id,slug,group_id,created_by) VALUES($1,$2,$3,$4)`,
      [layerId, `publication-outbox-${layerId}`, groupId, userId],
    );
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
         id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,created_by
       ) VALUES($1,$2,1,'publishing','Publication outbox','point','{point}',$3)`,
      [revisionId, layerId, userId],
    );
    await AppDataSource.query(
      `INSERT INTO publication_jobs(
         id,layer_id,revision_id,requested_by,request_id,client_intent,release_note,
         revision_lock_version,revision_schema_version,revision_fingerprint
       ) VALUES($1,$2,$3,$4,$5,'desktop','Outbox durability fixture',1,1,$6)`,
      [jobId, layerId, revisionId, userId, randomUUID(), 'c'.repeat(64)],
    );
    await AppDataSource.query(`INSERT INTO publication_job_outbox(publication_job_id) VALUES($1)`, [
      jobId,
    ]);
    return { layerId, revisionId, jobId };
  }

  async function componentErrors() {
    const rows = (await AppDataSource.query(
      `SELECT dispatch_error_code,worker_error_code FROM publication_worker_state WHERE id=1`,
    )) as Array<{ dispatch_error_code: string | null; worker_error_code: string | null }>;
    return rows[0]!;
  }

  async function markOutboxDispatched(jobId: string): Promise<void> {
    const leaseToken = randomUUID();
    await AppDataSource.query(
      `UPDATE publication_job_outbox
       SET status='dispatching',attempts=attempts+1,lease_token=$2,
           lease_owner='fairness-fixture',lease_expires_at=now()+interval '1 minute'
       WHERE publication_job_id=$1`,
      [jobId, leaseToken],
    );
    await AppDataSource.query(
      `UPDATE publication_job_outbox
       SET status='dispatched',dispatched_at=now(),lease_token=NULL,
           lease_owner=NULL,lease_expires_at=NULL
       WHERE publication_job_id=$1 AND lease_token=$2`,
      [jobId, leaseToken],
    );
  }
});
