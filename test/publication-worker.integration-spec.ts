import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import AppDataSource from '../src/database/data-source';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { PUBLICATION_BUILD_JOB, PUBLICATION_QUEUE } from '../src/jobs/jobs.constants';
import { GeoServiceAdapter } from '../src/public-api/geo-service.adapter';
import { PublicApiService } from '../src/public-api/public-api.service';
import { PublicationActivationService } from '../src/publications/publication-activation.service';
import { PublicationBuilderService } from '../src/publications/publication-builder.service';
import { PublicationFingerprintService } from '../src/publications/publication-fingerprint.service';
import { PublicationJobRepository } from '../src/publications/publication-job.repository';
import { PublicationRecoveryService } from '../src/publications/publication-recovery.service';
import { PublicationTestHooksService } from '../src/publications/publication-test-hooks.service';
import { publicationJobView } from '../src/publications/publication-view';
import { PublicationWorkerRepository } from '../src/publications/publication-worker.repository';
import { PublicationProcessor } from '../src/publications/publication.processor';

jest.setTimeout(90_000);

interface Fixture {
  groupId: string;
  layerId: string;
  revisionId: string;
  jobId: string;
  featureIds: string[];
  slug: string;
  baseRevisionId: string | null;
  baseSnapshotId: string | null;
}

interface PublicationQueueData {
  publicationJobId: string;
  payloadVersion: number;
}

const redisConnection = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  connectTimeout: 5_000,
};

describe('durable publication worker with real PostgreSQL and Redis', () => {
  const startedAt = new Date();
  const userId = randomUUID();
  const fixtures: Fixture[] = [];
  const queuePrefix = `danangmap:test:publication-worker:${process.pid}:${randomUUID()}`;
  let queue: Queue<PublicationQueueData>;
  let queueEvents: QueueEvents;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      `INSERT INTO users(
         id,email,email_normalized,username,username_normalized,display_name,role,status,password_hash
       ) VALUES($1,$2,$2,$3,$3,'Publication worker','publisher','active','test-hash')`,
      [userId, `publication-worker-${userId}@example.vn`, `publication_worker_${userId}`],
    );
    queue = new Queue<PublicationQueueData>(PUBLICATION_QUEUE, {
      connection: redisConnection,
      prefix: queuePrefix,
    });
    queueEvents = new QueueEvents(PUBLICATION_QUEUE, {
      connection: redisConnection,
      prefix: queuePrefix,
    });
    await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady()]);
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queueEvents?.close();
    await queue?.close();
    if (!AppDataSource.isInitialized) return;
    const layerIds = fixtures.map((fixture) => fixture.layerId);
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query(
        'ALTER TABLE workflow_events DISABLE TRIGGER trg_workflow_events_immutable',
      );
      if (layerIds.length > 0) {
        await manager.query(`DELETE FROM publication_jobs WHERE layer_id=ANY($1::uuid[])`, [
          layerIds,
        ]);
        await manager.query(
          `DELETE FROM audit_logs
           WHERE id IN (SELECT audit_id FROM audit_layer_scopes WHERE layer_id=ANY($1::uuid[]))`,
          [layerIds],
        );
        await manager.query(
          `DELETE FROM workflow_events WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layerIds],
        );
        await manager.query(
          `DELETE FROM revision_participants WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layerIds],
        );
        await manager.query(
          `DELETE FROM revision_features WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layerIds],
        );
        await manager.query(
          `DELETE FROM feature_versions WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layerIds],
        );
        await manager.query(
          `DELETE FROM layer_fields WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layerIds],
        );
        await manager.query(`DELETE FROM layer_publications WHERE layer_id=ANY($1::uuid[])`, [
          layerIds,
        ]);
        await manager.query(`DELETE FROM publication_snapshots WHERE layer_id=ANY($1::uuid[])`, [
          layerIds,
        ]);
        await manager.query(`DELETE FROM features WHERE layer_id=ANY($1::uuid[])`, [layerIds]);
        await manager.query(`DELETE FROM layer_revisions WHERE layer_id=ANY($1::uuid[])`, [
          layerIds,
        ]);
        await manager.query(`DELETE FROM layers WHERE id=ANY($1::uuid[])`, [layerIds]);
        await manager.query(`DELETE FROM layer_groups WHERE id=ANY($1::uuid[])`, [
          fixtures.map((fixture) => fixture.groupId),
        ]);
      }
      await manager.query(`DELETE FROM audit_logs WHERE actor_id=$1 AND occurred_at >= $2`, [
        userId,
        startedAt,
      ]);
      await manager.query(
        'ALTER TABLE workflow_events ENABLE TRIGGER trg_workflow_events_immutable',
      );
      await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
    });
    await AppDataSource.query(`DELETE FROM users WHERE id=$1`, [userId]);
    await AppDataSource.destroy();
  });

  it('resumes measured keyset batches, excludes private values and activates exactly once', async () => {
    const fixture = await createFixture(3);
    const firstProcessor = services({ testFailpoint: 'after_batch_commit' }).processor;
    await expect(firstProcessor.process(queueJob(fixture.jobId))).rejects.toThrow(
      'PUBLICATION_DEPENDENCY_UNAVAILABLE',
    );

    const afterCrash = await jobState(fixture.jobId);
    expect(afterCrash).toMatchObject({
      status: 'queued',
      phase: 'queued',
      feature_total: 3,
      feature_processed: 1,
      attempts: 1,
    });
    expect(await batchCount(fixture.jobId)).toBe(1);
    await AppDataSource.query(
      `UPDATE publication_jobs
       SET available_at=now(),lock_version=lock_version+1 WHERE id=$1`,
      [fixture.jobId],
    );

    await services().processor.process(queueJob(fixture.jobId));
    const completed = await jobState(fixture.jobId);
    expect(completed).toMatchObject({
      status: 'succeeded',
      phase: 'completed',
      feature_total: 3,
      feature_processed: 3,
      attempts: 2,
    });
    expect(completed.result_snapshot_id).toBeTruthy();
    expect(await batchCount(fixture.jobId)).toBe(3);

    const projections = (await AppDataSource.query(
      `SELECT public_projection,public_checksum
       FROM publication_job_batches WHERE job_id=$1 ORDER BY batch_no`,
      [fixture.jobId],
    )) as Array<{
      public_projection: Array<{
        type: 'Feature';
        id: string;
        geometry: Record<string, unknown>;
        properties: Record<string, unknown>;
        geometryKind: string;
        radiusM: number | null;
      }>;
      public_checksum: string;
    }>;
    expect(projections.flatMap((batch) => batch.public_projection)).toHaveLength(3);
    for (const feature of projections.flatMap((batch) => batch.public_projection)) {
      expect(Object.keys(feature.properties)).toEqual(['name']);
      expect(feature.properties.name).toMatch(/^public-/);
      expect(JSON.stringify(feature)).not.toContain('private-canary');
      expect(JSON.stringify(feature)).not.toContain('credential-canary');
      expect(JSON.stringify(feature)).not.toContain('storage-key-canary');
      expect(JSON.stringify(feature)).not.toContain('image-key-canary');
    }
    const crypto = new CryptoService(workerConfig());
    for (const batch of projections) {
      const projectionInBuilderOrder = batch.public_projection.map((feature) => ({
        type: feature.type,
        id: feature.id,
        geometry: feature.geometry,
        properties: feature.properties,
        geometryKind: feature.geometryKind,
        radiusM: feature.radiusM,
      }));
      expect(batch.public_checksum).toBe(crypto.checksum(JSON.stringify(projectionInBuilderOrder)));
    }
    const snapshot = (await AppDataSource.query(
      `SELECT snapshot.checksum,job.build_checksum
       FROM publication_jobs job
       JOIN publication_snapshots snapshot ON snapshot.id=job.result_snapshot_id
       WHERE job.id=$1`,
      [fixture.jobId],
    )) as Array<{ checksum: string; build_checksum: string }>;
    const expectedSnapshotChecksum = crypto.checksum(
      projections.map((batch) => batch.public_checksum).join(''),
    );
    expect(snapshot[0]).toEqual({
      checksum: expectedSnapshotChecksum,
      build_checksum: expectedSnapshotChecksum,
    });

    const publicApi = publicApiService();
    const catalog = await publicApi.catalog();
    const catalogLayer = catalog.data.find((layer) => layer.id === fixture.layerId);
    expect(catalogLayer).toMatchObject({
      filterCapabilities: { fieldKeys: ['name'] },
      searchCapabilities: { enabled: true, fieldKeys: ['name'] },
    });
    expectNoPublicCanaries(catalogLayer);

    const detail = await publicApi.layerDetail(fixture.slug);
    expect(detail.data.fields.map((field) => field.key)).toEqual(['name']);
    expectNoPublicCanaries(detail.data);

    const collection = await publicApi.featureCollection(fixture.slug, undefined, 1000);
    expect(collection.etag).toBe(publicEtag(collection.data));
    expect(
      [...collection.data.features].sort((left, right) =>
        String(left.id).localeCompare(String(right.id)),
      ),
    ).toEqual(
      projections
        .flatMap((batch) => batch.public_projection)
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    expectNoPublicCanaries(collection.data);

    const firstFeature = await publicApi.feature(fixture.slug, fixture.featureIds[0]!);
    expect(firstFeature.data.properties).toEqual({ name: 'public-0' });
    expect(firstFeature.data.attachments).toEqual([]);
    expectNoPublicCanaries(firstFeature.data);

    const filtered = await publicApi.featureCollection(
      fixture.slug,
      undefined,
      1000,
      'name:eq:public-0',
    );
    expect(filtered.data.features.map((feature) => feature.id)).toEqual([fixture.featureIds[0]]);
    await expect(
      publicApi.featureCollection(
        fixture.slug,
        undefined,
        1000,
        'documents:eq:storage-key-canary-0',
      ),
    ).rejects.toMatchObject({ code: 'FILTER_NOT_ALLOWED' });
    await expect(
      publicApi.featureCollection(fixture.slug, undefined, 1000, 'photo:eq:image-key-canary-0'),
    ).rejects.toMatchObject({ code: 'FILTER_NOT_ALLOWED' });

    const search = await publicApi.search({ q: 'public-0', sources: 'internal', limit: 10 });
    expect(search.data.some((result) => result.featureId === fixture.featureIds[0])).toBe(true);
    for (const canary of [
      'private-canary',
      'credential-canary',
      'storage-key-canary',
      'image-key-canary',
    ]) {
      const hiddenSearch = await publicApi.search({ q: `${canary}-0`, sources: 'internal' });
      expect(hiddenSearch.data).toEqual([]);
    }

    const tile = await publicApi.tile(fixture.slug, 1, 0, 0, 0);
    expect(tile.etag).toBe(`"tile-${String(completed.result_snapshot_id)}-1-0-0-0"`);
    expect(tile.etag).not.toContain(expectedSnapshotChecksum);
    expectNoPublicCanaries(tile.tile.toString('latin1'));

    const beforeExcludedMutation = {
      data: collection.data,
      etag: collection.etag,
      tile: tile.tile,
      tileEtag: tile.etag,
    };
    await AppDataSource.query(
      `UPDATE feature_versions
       SET properties=jsonb_set(
         jsonb_set(properties,'{documents}','["storage-key-canary-mutated"]'::jsonb),
         '{photo}','["image-key-canary-mutated"]'::jsonb
       ) WHERE revision_id=$1`,
      [fixture.revisionId],
    );
    const afterExcludedMutation = await publicApi.featureCollection(fixture.slug, undefined, 1000);
    const tileAfterExcludedMutation = await publicApi.tile(fixture.slug, 1, 0, 0, 0);
    expect(afterExcludedMutation).toEqual({
      data: beforeExcludedMutation.data,
      etag: beforeExcludedMutation.etag,
    });
    expect(tileAfterExcludedMutation).toEqual({
      tile: beforeExcludedMutation.tile,
      etag: beforeExcludedMutation.tileEtag,
    });

    const beforeReplay = await activationCounts(fixture);
    await services().processor.process(queueJob(fixture.jobId));
    expect(await activationCounts(fixture)).toEqual(beforeReplay);

    const worker = new Worker<PublicationQueueData>(
      PUBLICATION_QUEUE,
      async (job) => services().processor.process(job),
      { connection: redisConnection, prefix: queuePrefix, autorun: true },
    );
    await worker.waitUntilReady();
    try {
      const delivery = await queue.add(
        PUBLICATION_BUILD_JOB,
        { publicationJobId: fixture.jobId, payloadVersion: 1 },
        { jobId: `publication-${fixture.jobId}`, removeOnComplete: false },
      );
      await delivery.waitUntilFinished(queueEvents, 20_000);
    } finally {
      await worker.close();
    }
    expect(await activationCounts(fixture)).toEqual(beforeReplay);
  });

  it('publishes an empty approved revision with truthful terminal progress', async () => {
    const fixture = await createFixture(0);
    await services().processor.process(queueJob(fixture.jobId));
    const completed = await jobState(fixture.jobId);
    expect(completed).toMatchObject({
      status: 'succeeded',
      phase: 'completed',
      feature_total: 0,
      feature_processed: 0,
    });
    expect(await batchCount(fixture.jobId)).toBe(0);
    expect(await activationCounts(fixture)).toMatchObject({
      snapshots: 1,
      pointers: 1,
      publications: 1,
    });
  });

  it('never derives public search title or subtitle from private identity fields', async () => {
    const fixture = await createFixture(1, { privateSearchIdentity: true });
    await services().processor.process(queueJob(fixture.jobId));

    const publicApi = publicApiService();
    const detail = await publicApi.layerDetail(fixture.slug);
    expect(detail.data.fields.map((field) => field.key)).toEqual(['code']);
    expect(detail.data.filterCapabilities.fieldKeys).toEqual(['code']);
    expect(detail.data.searchCapabilities.fieldKeys).toEqual(['code']);
    expectNoPublicCanaries(detail.data);

    const publicMatch = await publicApi.search({
      q: 'public-code-0',
      sources: 'internal',
      layerIds: fixture.layerId,
    });
    expect(publicMatch.data).toHaveLength(1);
    expect(publicMatch.data[0]).toMatchObject({
      featureId: fixture.featureIds[0],
      title: fixture.featureIds[0],
      subtitle: null,
    });
    expectNoPublicCanaries(publicMatch);

    for (const canary of [
      'private-name-canary-0',
      'private-title-canary-0',
      'private-address-canary-0',
    ]) {
      const hidden = await publicApi.search({
        q: canary,
        sources: 'internal',
        layerIds: fixture.layerId,
      });
      expect(hidden.data).toEqual([]);
    }
  });

  it.each([
    {
      name: 'disabled actor',
      code: 'PUBLICATION_ACTOR_INELIGIBLE',
      mutate: async (fixture: Fixture) => {
        await AppDataSource.query(`UPDATE users SET disabled_at=now() WHERE id=$1`, [userId]);
        return fixture;
      },
    },
    {
      name: 'publisher role removed',
      code: 'PUBLICATION_ACTOR_INELIGIBLE',
      mutate: async (fixture: Fixture) => {
        await AppDataSource.query(`UPDATE users SET role='editor' WHERE id=$1`, [userId]);
        return fixture;
      },
    },
    {
      name: 'editorial participation added after admission',
      code: 'PUBLICATION_SEPARATION_OF_DUTIES',
      mutate: async (fixture: Fixture) => {
        await AppDataSource.query(
          `INSERT INTO revision_participants(revision_id,user_id,participation_type)
           VALUES($1,$2,'edit')`,
          [fixture.revisionId, userId],
        );
        return fixture;
      },
    },
    {
      name: 'required public property removed after admission',
      code: 'PUBLICATION_INPUT_INVALID',
      mutate: async (fixture: Fixture) => {
        await AppDataSource.query(
          `UPDATE feature_versions SET properties=properties-'name'
           WHERE revision_id=$1`,
          [fixture.revisionId],
        );
        return fixture;
      },
    },
  ])('fails safely with zero pointer mutation when $name', async ({ code, mutate }) => {
    await AppDataSource.query(
      `UPDATE users SET role='publisher',status='active',disabled_at=NULL WHERE id=$1`,
      [userId],
    );
    const fixture = await mutate(await createFixture(1));
    try {
      await services().processor.process(queueJob(fixture.jobId));
      const state = await jobState(fixture.jobId);
      expect(state).toMatchObject({
        status: 'failed',
        phase: 'failed',
        failure_code: code,
        result_snapshot_id: null,
        lease_token: null,
      });
      expect(state.failure_correlation_id).toEqual(expect.any(String));
      const revisions = (await AppDataSource.query(
        `SELECT status FROM layer_revisions WHERE id=$1`,
        [fixture.revisionId],
      )) as Array<{ status: string }>;
      expect(revisions[0]?.status).toBe('approved');
      expect(await activationCounts(fixture)).toEqual({
        snapshots: 0,
        pointers: 0,
        publications: 0,
        audits: 0,
        events: 0,
      });

      const row = await new PublicationJobRepository(AppDataSource).findById(fixture.jobId);
      expect(row).not.toBeNull();
      const view = publicationJobView(row!);
      expect(view.failure).toMatchObject({ code, retryable: false });
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain('private-canary');
      expect(serialized).not.toContain('credential-canary');
      expect(serialized).not.toContain('storage-key-canary');
      expect(serialized).not.toContain('QueryFailedError');
    } finally {
      await AppDataSource.query(
        `UPDATE users SET role='publisher',status='active',disabled_at=NULL WHERE id=$1`,
        [userId],
      );
    }
  });

  it('rejects a measured build over the configured feature limit without switching the pointer', async () => {
    const fixture = await createFixture(2);
    await services({ maxFeatures: 1 }).processor.process(queueJob(fixture.jobId));
    expect(await jobState(fixture.jobId)).toMatchObject({
      status: 'failed',
      failure_code: 'PUBLICATION_BUILD_LIMIT_EXCEEDED',
      feature_total: null,
      feature_processed: 0,
    });
    expect(await activationCounts(fixture)).toMatchObject({ snapshots: 0, pointers: 0 });
  });

  it('treats a crash after the final commit as an idempotent terminal delivery', async () => {
    const fixture = await createFixture(1);
    await expect(
      services({ testFailpoint: 'after_final_commit' }).processor.process(queueJob(fixture.jobId)),
    ).rejects.toThrow('PUBLICATION_DEPENDENCY_UNAVAILABLE');
    expect(await jobState(fixture.jobId)).toMatchObject({
      status: 'succeeded',
      phase: 'completed',
      feature_total: 1,
      feature_processed: 1,
    });
    const committed = await activationCounts(fixture);
    await services().processor.process(queueJob(fixture.jobId));
    expect(await activationCounts(fixture)).toEqual(committed);
  });

  it('recovers an expired database lease and recreates deterministic Bull delivery', async () => {
    const fixture = await createFixture(1);
    const stack = services();
    const claim = await stack.repository.claim(fixture.jobId, 'crashed-worker', 30);
    expect(claim.kind).toBe('claimed');
    await AppDataSource.query(
      `UPDATE publication_jobs
       SET lease_expires_at=now()-interval '1 second',lock_version=lock_version+1 WHERE id=$1`,
      [fixture.jobId],
    );
    const config = workerConfig();
    const recovery = new PublicationRecoveryService(
      queue,
      new PublicationJobRepository(AppDataSource),
      stack.repository,
      config,
    );
    await recovery.recoverOnce();
    expect(await jobState(fixture.jobId)).toMatchObject({
      status: 'queued',
      phase: 'queued',
      lease_token: null,
      lease_expires_at: null,
    });
    const bullJob = await queue.getJob(`publication-${fixture.jobId}`);
    expect(bullJob?.data).toEqual({ publicationJobId: fixture.jobId, payloadVersion: 1 });
    const workerState = (await AppDataSource.query(
      `SELECT recovered_lease_count,worker_heartbeat_at,worker_error_code
       FROM publication_worker_state WHERE id=1`,
    )) as Array<Record<string, unknown>>;
    expect(Number(workerState[0]?.recovered_lease_count)).toBeGreaterThanOrEqual(1);
    expect(workerState[0]?.worker_heartbeat_at).toBeInstanceOf(Date);
    expect(workerState[0]?.worker_error_code).toBeNull();
    await recovery.onApplicationShutdown();
  });

  it('terminalizes an exhausted build after its database lease expires', async () => {
    const fixture = await createFixture(1);
    const stack = services();
    const claim = await stack.repository.claim(fixture.jobId, 'exhausted-worker', 30);
    expect(claim.kind).toBe('claimed');
    await AppDataSource.query(
      `UPDATE publication_jobs
       SET attempts=max_attempts,lease_expires_at=now()-interval '1 second',
           lock_version=lock_version+1 WHERE id=$1`,
      [fixture.jobId],
    );

    await stack.processor.process(queueJob(fixture.jobId));

    expect(await jobState(fixture.jobId)).toMatchObject({
      status: 'failed',
      phase: 'failed',
      failure_code: 'PUBLICATION_RETRY_EXHAUSTED',
      lease_token: null,
      lease_expires_at: null,
    });
    const revisions = (await AppDataSource.query(`SELECT status FROM layer_revisions WHERE id=$1`, [
      fixture.revisionId,
    ])) as Array<{ status: string }>;
    expect(revisions[0]?.status).toBe('approved');
    expect(await activationCounts(fixture)).toMatchObject({ snapshots: 0, pointers: 0 });
  });

  it('keeps the public pointer stable until the final transaction and then changes its ETag', async () => {
    const fixture = await createFixture(2, { basePointer: true });
    const publicApi = publicApiService();
    const before = await publicApi.layerDetail(fixture.slug);
    expect(before.data.generation).toBe(1);
    expect(before.data.snapshotId).toBe(fixture.baseSnapshotId);

    const barrierRunner = AppDataSource.createQueryRunner();
    await barrierRunner.connect();
    const barrierKey = `danangmap:publication:test:before_pointer_switch:${fixture.jobId}`;
    await barrierRunner.query(`SELECT pg_advisory_lock(hashtextextended($1,0))`, [barrierKey]);
    const processing = services({ testBarrier: 'before_pointer_switch' }).processor.process(
      queueJob(fixture.jobId),
    );
    try {
      await waitFor(async () => (await jobState(fixture.jobId)).phase === 'switching');
      const whileBuilding = await publicApi.layerDetail(fixture.slug);
      expect(whileBuilding.etag).toBe(before.etag);
      expect(whileBuilding.data.snapshotId).toBe(fixture.baseSnapshotId);
      expect(whileBuilding.data.generation).toBe(1);
    } finally {
      await barrierRunner.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [barrierKey]);
      await barrierRunner.release();
    }
    await processing;

    const after = await publicApi.layerDetail(fixture.slug);
    expect(after.etag).not.toBe(before.etag);
    expect(after.data.snapshotId).not.toBe(fixture.baseSnapshotId);
    expect(after.data.generation).toBe(2);
    expect(await activationCounts(fixture)).toMatchObject({
      snapshots: 2,
      pointers: 1,
      publications: 1,
      audits: 1,
      events: 1,
    });
  });

  it('fails stale-base activation without changing the competing public pointer or ETag', async () => {
    const fixture = await createFixture(1, { basePointer: true });
    const competingSnapshotId = randomUUID();
    await AppDataSource.query(
      `INSERT INTO publication_snapshots(
         id,layer_id,revision_id,status,generation,feature_count,checksum,manifest,
         published_by,published_at,activated_at
       ) VALUES($1,$2,$3,'published',2,0,'competing','{}'::jsonb,$4,now(),now())`,
      [competingSnapshotId, fixture.layerId, fixture.baseRevisionId, userId],
    );
    await AppDataSource.query(
      `UPDATE layer_publications
       SET previous_snapshot_id=active_snapshot_id,active_snapshot_id=$2,pointer_updated_at=now()
       WHERE layer_id=$1`,
      [fixture.layerId, competingSnapshotId],
    );
    const publicApi = publicApiService();
    const primed = await publicApi.layerDetail(fixture.slug);
    expect(primed.data.snapshotId).toBe(competingSnapshotId);
    expect(primed.data.generation).toBe(2);

    await services().processor.process(queueJob(fixture.jobId));
    expect(await jobState(fixture.jobId)).toMatchObject({
      status: 'failed',
      failure_code: 'PUBLICATION_BASE_STALE',
      result_snapshot_id: null,
      feature_processed: 0,
    });
    const after = await publicApi.layerDetail(fixture.slug);
    expect(after.etag).toBe(primed.etag);
    expect(after.data.snapshotId).toBe(competingSnapshotId);
    expect(after.data.generation).toBe(2);
    expect(await activationCounts(fixture)).toMatchObject({
      snapshots: 2,
      pointers: 1,
      publications: 0,
      audits: 0,
      events: 0,
    });
  });

  function workerConfig(
    options: { testFailpoint?: string; testBarrier?: string; maxFeatures?: number } = {},
  ) {
    return new ConfigService({
      app: { environment: 'test' },
      publication: {
        buildLeaseSeconds: 30,
        buildBatchSize: 1,
        heartbeatIntervalMs: 5_000,
        retryBackoffMs: 1,
        maxAttempts: 5,
        dispatchBatchSize: 25,
        recoveryIntervalMs: 60_000,
        maxFeatures: options.maxFeatures ?? 100,
        maxVertices: 10_000,
        testFailpoint: options.testFailpoint,
        testBarrier: options.testBarrier,
      },
      FIELD_ENCRYPTION_KEY: 'publication-worker-test-encryption-key',
      SESSION_PEPPER: 'publication-worker-test-pepper',
    });
  }

  function services(
    options: { testFailpoint?: string; testBarrier?: string; maxFeatures?: number } = {},
  ) {
    const config = workerConfig(options);
    const crypto = new CryptoService(config);
    const fingerprint = new PublicationFingerprintService(crypto);
    const repository = new PublicationWorkerRepository(AppDataSource);
    const activation = new PublicationActivationService(AppDataSource, crypto, fingerprint);
    const hooks = new PublicationTestHooksService(config, AppDataSource);
    const builder = new PublicationBuilderService(
      repository,
      activation,
      fingerprint,
      hooks,
      crypto,
      config,
      AppDataSource,
    );
    return {
      repository,
      activation,
      processor: new PublicationProcessor(repository, builder, activation, config),
    };
  }

  function publicApiService(): PublicApiService {
    const config = new ConfigService({
      geoService: {
        baseUrl: '',
        connectTimeoutMs: 1_000,
        totalTimeoutMs: 2_000,
        retryAttempts: 1,
        retryDelayMs: 0,
        breakerFailureThreshold: 2,
        breakerOpenMs: 1_000,
      },
    });
    return new PublicApiService(AppDataSource, new GeoServiceAdapter(config));
  }

  async function createFixture(
    featureCount: number,
    options: { basePointer?: boolean; privateSearchIdentity?: boolean } = {},
  ): Promise<Fixture> {
    const fixture: Fixture = {
      groupId: randomUUID(),
      layerId: randomUUID(),
      revisionId: randomUUID(),
      jobId: randomUUID(),
      featureIds: [],
      slug: `publication-worker-${randomUUID()}`,
      baseRevisionId: options.basePointer ? randomUUID() : null,
      baseSnapshotId: options.basePointer ? randomUUID() : null,
    };
    fixtures.push(fixture);
    await AppDataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO layer_groups(id,slug,title) VALUES($1,$2,'Publication worker group')`,
        [fixture.groupId, `publication-worker-${fixture.groupId}`],
      );
      await manager.query(`INSERT INTO layers(id,slug,group_id,created_by) VALUES($1,$2,$3,$4)`, [
        fixture.layerId,
        fixture.slug,
        fixture.groupId,
        userId,
      ]);
      if (fixture.baseRevisionId && fixture.baseSnapshotId) {
        await manager.query(
          `INSERT INTO layer_revisions(
             id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,
             created_by,published_at
           ) VALUES($1,$2,1,'published','Base publication','point','{point}',$3,now())`,
          [fixture.baseRevisionId, fixture.layerId, userId],
        );
        await manager.query(
          `INSERT INTO layer_fields(
             revision_id,key,label,type,required,public,sensitive,offline_cache,display_order
           ) VALUES($1,'name','Name','text',false,true,false,true,1)`,
          [fixture.baseRevisionId],
        );
        await manager.query(
          `INSERT INTO publication_snapshots(
             id,layer_id,revision_id,status,generation,feature_count,checksum,manifest,
             published_by,published_at,activated_at
           ) VALUES($1,$2,$3,'published',1,0,'base','{}'::jsonb,$4,now(),now())`,
          [fixture.baseSnapshotId, fixture.layerId, fixture.baseRevisionId, userId],
        );
        await manager.query(
          `INSERT INTO layer_publications(layer_id,active_snapshot_id) VALUES($1,$2)`,
          [fixture.layerId, fixture.baseSnapshotId],
        );
      }
      await manager.query(
        `INSERT INTO layer_revisions(
           id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,created_by,
           supersedes_revision_id
         ) VALUES($1,$2,$3,'publishing','Publication worker revision','point','{point}',$4,$5)`,
        [
          fixture.revisionId,
          fixture.layerId,
          options.basePointer ? 2 : 1,
          userId,
          fixture.baseRevisionId,
        ],
      );
      await manager.query(
        `INSERT INTO layer_fields(
           revision_id,key,label,type,required,public,sensitive,searchable,filterable,
           offline_cache,display_order
         ) VALUES
           ($1,'name','Name','text',$2,$3,false,$3,$3,true,1),
           ($1,'private_note','Private note','text',false,false,false,true,true,false,2),
           ($1,'api_key','API key','text',false,true,true,true,true,false,3),
           ($1,'documents','Storage key canary schema','attachment',false,true,false,true,true,false,4),
           ($1,'photo','Image key canary schema','image',false,true,false,true,true,false,5)`,
        [fixture.revisionId, !options.privateSearchIdentity, !options.privateSearchIdentity],
      );
      if (options.privateSearchIdentity) {
        await manager.query(
          `INSERT INTO layer_fields(
             revision_id,key,label,type,required,public,sensitive,searchable,filterable,
             offline_cache,display_order
           ) VALUES
             ($1,'title','Private title','text',false,false,false,true,true,false,6),
             ($1,'address','Private address','address',false,false,false,true,true,false,7),
             ($1,'code','Public code','text',true,true,false,true,true,true,8)`,
          [fixture.revisionId],
        );
      }
      for (let index = 0; index < featureCount; index += 1) {
        const featureId = randomUUID();
        const versionId = randomUUID();
        fixture.featureIds.push(featureId);
        await manager.query(`INSERT INTO features(id,layer_id) VALUES($1,$2)`, [
          featureId,
          fixture.layerId,
        ]);
        await manager.query(
          `INSERT INTO feature_versions(
             id,feature_id,revision_id,geometry,geometry_kind,properties,checksum,created_by
           ) VALUES(
             $1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326),'point',$6::jsonb,$7,$8
           )`,
          [
            versionId,
            featureId,
            fixture.revisionId,
            108.2 + index / 100,
            16 + index / 100,
            JSON.stringify(
              options.privateSearchIdentity
                ? {
                    name: `private-name-canary-${index}`,
                    title: `private-title-canary-${index}`,
                    address: `private-address-canary-${index}`,
                    code: `public-code-${index}`,
                    private_note: `private-canary-${index}`,
                    api_key: `credential-canary-${index}`,
                    documents: [`storage-key-canary-${index}`],
                    photo: [`image-key-canary-${index}`],
                  }
                : {
                    name: `public-${index}`,
                    private_note: `private-canary-${index}`,
                    api_key: `credential-canary-${index}`,
                    documents: [`storage-key-canary-${index}`],
                    photo: [`image-key-canary-${index}`],
                  },
            ),
            `source-checksum-${index}`,
            userId,
          ],
        );
        await manager.query(
          `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
           VALUES($1,$2,$3,$4)`,
          [fixture.revisionId, featureId, versionId, index + 1],
        );
      }
      const config = new ConfigService({
        FIELD_ENCRYPTION_KEY: 'publication-worker-test-encryption-key',
        SESSION_PEPPER: 'publication-worker-test-pepper',
      });
      const fingerprint = await new PublicationFingerprintService(
        new CryptoService(config),
      ).calculate(manager, fixture.revisionId);
      await manager.query(
        `INSERT INTO publication_jobs(
           id,layer_id,revision_id,requested_by,request_id,client_intent,release_note,
           expected_active_snapshot_id,expected_active_generation,
           revision_lock_version,revision_schema_version,revision_fingerprint,max_attempts
         ) VALUES($1,$2,$3,$4,$5,'desktop','Worker integration fixture',$6,$7,1,1,$8,5)`,
        [
          fixture.jobId,
          fixture.layerId,
          fixture.revisionId,
          userId,
          randomUUID(),
          fixture.baseSnapshotId,
          fixture.baseSnapshotId ? 1 : null,
          fingerprint,
        ],
      );
    });
    return fixture;
  }

  function queueJob(jobId: string): Job<PublicationQueueData> {
    return {
      name: PUBLICATION_BUILD_JOB,
      data: { publicationJobId: jobId, payloadVersion: 1 },
    } as Job<PublicationQueueData>;
  }

  async function jobState(jobId: string): Promise<Record<string, unknown>> {
    const rows = (await AppDataSource.query(`SELECT * FROM publication_jobs WHERE id=$1`, [
      jobId,
    ])) as Array<Record<string, unknown>>;
    return rows[0]!;
  }

  async function batchCount(jobId: string): Promise<number> {
    const rows = (await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM publication_job_batches WHERE job_id=$1`,
      [jobId],
    )) as Array<{ count: number }>;
    return rows[0]!.count;
  }

  async function activationCounts(fixture: Fixture) {
    const rows = (await AppDataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM publication_snapshots WHERE layer_id=$1) AS snapshots,
         (SELECT count(*)::integer FROM layer_publications WHERE layer_id=$1) AS pointers,
         (SELECT count(*)::integer FROM revision_participants
            WHERE revision_id=$2 AND participation_type='publish') AS publications,
         (SELECT count(*)::integer FROM audit_logs
            WHERE resource_id=$2 AND action='revision.published') AS audits,
         (SELECT count(*)::integer FROM workflow_events
            WHERE revision_id=$2 AND to_status='published') AS events`,
      [fixture.layerId, fixture.revisionId],
    )) as Array<Record<string, number>>;
    return rows[0]!;
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for publication test state.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function expectNoPublicCanaries(value: unknown): void {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    for (const canary of [
      'private-canary',
      'credential-canary',
      'storage-key-canary',
      'image-key-canary',
      'private-name-canary',
      'private-title-canary',
      'private-address-canary',
    ]) {
      expect(serialized).not.toContain(canary);
    }
  }

  function publicEtag(value: unknown): string {
    return `"${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}"`;
  }
});
