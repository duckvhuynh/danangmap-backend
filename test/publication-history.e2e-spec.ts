/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import { createHmac, randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import { E2E_PREAUTH_COOKIE, E2E_SESSION_COOKIE } from './auth-cookie.helper';

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
const createdLayerIds: string[] = [];

interface Actor {
  cookie: string;
  csrf: string;
}

interface Fixture {
  groupId: string;
  layerId: string;
  otherLayerId: string;
  revision1: string;
  revision2: string;
  feature1: string;
  snapshot1: string;
  snapshot2: string;
  neverActivatedSnapshot: string;
  attachmentIds: string[];
}

interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}

describe('Publication, revision and audit history HTTP E2E', () => {
  const startedAt = new Date();
  let publisher: Actor;
  let editor: Actor;
  let reviewer: Actor;
  let systemAdmin: Actor;
  let fixture: Fixture;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])',
      [Object.values(users).map((user) => user.id)],
    );
    [publisher, editor, reviewer, systemAdmin] = await Promise.all([
      login(users.publisher),
      login(users.editor),
      login(users.reviewer),
      login(users.systemAdmin),
    ]);
    fixture = await createFixture();
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.query(
      `DROP TRIGGER IF EXISTS trg_test_rollback_failure ON publication_snapshots`,
    );
    await AppDataSource.query(`DROP FUNCTION IF EXISTS test_reject_rollback_snapshot()`);
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query(
        'ALTER TABLE workflow_events DISABLE TRIGGER trg_workflow_events_immutable',
      );
      await manager.query(`DELETE FROM command_receipts WHERE created_at >= $1`, [startedAt]);
      await manager.query(`DELETE FROM audit_logs WHERE occurred_at >= $1`, [startedAt]);
      await manager.query(`DELETE FROM workflow_events WHERE occurred_at >= $1`, [startedAt]);
      const layers = [...createdLayerIds];
      if (layers.length) {
        await manager.query(
          `DELETE FROM audit_logs WHERE
             (resource_type='layer' AND resource_id=ANY($1::uuid[])) OR
             (resource_type IN ('revision','layer_revision') AND resource_id IN
               (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))) OR
             (resource_type='feature' AND resource_id IN
               (SELECT id FROM features WHERE layer_id=ANY($1::uuid[]))) OR
             (resource_type='publication' AND resource_id IN
               (SELECT id FROM publication_snapshots WHERE layer_id=ANY($1::uuid[])))`,
          [layers],
        );
        await manager.query(
          `DELETE FROM workflow_events WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layers],
        );
        await manager.query(
          `DELETE FROM revision_participants WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layers],
        );
        await manager.query(
          `DELETE FROM revision_changes WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layers],
        );
        await manager.query(
          `DELETE FROM revision_features WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layers],
        );
        await manager.query(
          `DELETE FROM feature_versions WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layers],
        );
        if (fixture?.attachmentIds.length) {
          await manager.query(`DELETE FROM attachments WHERE id=ANY($1::uuid[])`, [
            fixture.attachmentIds,
          ]);
        }
        await manager.query(
          `DELETE FROM layer_fields WHERE revision_id IN
             (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))`,
          [layers],
        );
        await manager.query(`DELETE FROM layer_publications WHERE layer_id=ANY($1::uuid[])`, [
          layers,
        ]);
        await manager.query(`DELETE FROM publication_snapshots WHERE layer_id=ANY($1::uuid[])`, [
          layers,
        ]);
        await manager.query(`DELETE FROM features WHERE layer_id=ANY($1::uuid[])`, [layers]);
        await manager.query(`DELETE FROM layer_revisions WHERE layer_id=ANY($1::uuid[])`, [layers]);
        await manager.query(`DELETE FROM layers WHERE id=ANY($1::uuid[])`, [layers]);
      }
      if (fixture?.groupId)
        await manager.query(`DELETE FROM layer_groups WHERE id=$1`, [fixture.groupId]);
      await manager.query(`UPDATE users SET role='editor' WHERE id=$1`, [users.editor.id]);
      await manager.query(
        'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])',
        [Object.values(users).map((user) => user.id)],
      );
      await manager.query(
        'ALTER TABLE workflow_events ENABLE TRIGGER trg_workflow_events_immutable',
      );
      await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
    });
    await AppDataSource.destroy();
  });

  it('returns bounded cursor pages, safe feature-level diff and truthful publication state', async () => {
    const history = await get(editor, `/api/v1/admin/layers/${fixture.layerId}/history?limit=1`);
    expect(history.status).toBe(200);
    expect(history.headers.get('etag')).toBeTruthy();
    const historyBody =
      await json<Envelope<{ items: unknown[]; hasMore: boolean; nextCursor: string }>>(history);
    expect(historyBody.data.items).toHaveLength(1);
    expect(historyBody.data.hasMore).toBe(true);
    expect(historyBody.data.nextCursor).toBeTruthy();

    const diff = await get(
      reviewer,
      `/api/v1/admin/revisions/${fixture.revision2}/diff?compareTo=parent&limit=1`,
    );
    expect(diff.status).toBe(200);
    const diffBody = await json<
      Envelope<{
        entries: Array<Record<string, any>>;
        hasMore: boolean;
        nextCursor: string;
        attachments: Record<string, unknown>;
      }>
    >(diff);
    expect(diffBody.data.entries).toHaveLength(1);
    expect(diffBody.data.hasMore).toBe(true);
    expect(diffBody.data.nextCursor).toBeTruthy();
    expect(diffBody.data.attachments).toEqual({
      available: true,
      featuresModified: 1,
      added: 1,
      removed: 1,
      reordered: 1,
      redactedChangeCount: 2,
    });
    expect(JSON.stringify(diffBody.data)).not.toContain('private-before');
    expect(JSON.stringify(diffBody.data)).not.toContain('private-after');
    expect(JSON.stringify(diffBody.data)).not.toContain('storage-key');
    expect(JSON.stringify(diffBody.data)).not.toContain('history-storage');
    expect(JSON.stringify(diffBody.data)).not.toContain('history-quarantine');
    expect(JSON.stringify(diffBody.data)).not.toContain('Checksum');

    const secondDiff = await get(
      reviewer,
      `/api/v1/admin/revisions/${fixture.revision2}/diff?compareTo=parent&limit=25&cursor=${encodeURIComponent(diffBody.data.nextCursor)}`,
    );
    expect(secondDiff.status).toBe(200);
    const secondBody = await json<Envelope<{ entries: Array<Record<string, any>> }>>(secondDiff);
    const entries = [...diffBody.data.entries, ...secondBody.data.entries];
    const modified = entries.find((entry) => entry.featureId === fixture.feature1)!;
    expect(modified.changeType).toBe('modified');
    expect(modified.geometry).toMatchObject({ beforeRadiusM: 100, afterRadiusM: 200 });
    expect(modified.properties).toMatchObject({
      before: { name: 'before' },
      after: { name: 'after' },
      changedKeys: ['name'],
    });
    expect(modified.attachments).toEqual({
      available: true,
      changed: true,
      added: [
        expect.objectContaining({
          id: fixture.attachmentIds[2],
          fieldKey: 'documents',
          displayOrder: 2,
          fileName: 'added-public.pdf',
          contentType: 'application/pdf',
          sizeBytes: 13,
          status: 'clean',
        }),
      ],
      removed: [
        expect.objectContaining({
          id: fixture.attachmentIds[1],
          fieldKey: 'documents',
          displayOrder: 1,
          fileName: 'removed-public.pdf',
          contentType: 'application/pdf',
          sizeBytes: 12,
          status: 'clean',
        }),
      ],
      reordered: [
        {
          id: fixture.attachmentIds[0],
          fieldKey: 'documents',
          fileName: 'shared-public.pdf',
          beforeDisplayOrder: 0,
          afterDisplayOrder: 1,
        },
      ],
      redactedChange: true,
    });
    expect(modified.redactedChange).toBe(true);
    expect(JSON.stringify(modified.attachments)).not.toContain('private-attachment');
    expect(entries.some((entry) => entry.geometry.afterPreviewMode === 'bbox')).toBe(true);

    const publications = await get(
      publisher,
      `/api/v1/admin/layers/${fixture.layerId}/publications?limit=2`,
    );
    expect(publications.status).toBe(200);
    const publicationBody = await json<
      Envelope<{
        items: Array<Record<string, any>>;
        activePointerEtag: string;
        hasMore: boolean;
      }>
    >(publications);
    expect(publicationBody.data.items).toHaveLength(2);
    expect(publicationBody.data.hasMore).toBe(true);
    expect(
      publicationBody.data.items.find((item) => item.snapshotId === fixture.snapshot2),
    ).toMatchObject({
      isActive: true,
      progress: 100,
    });
    expect(
      publicationBody.data.items.find((item) => item.snapshotId === fixture.neverActivatedSnapshot),
    ).toMatchObject({
      isActive: false,
      rollbackEligibility: { eligible: false, reasonCode: 'ROLLBACK_TARGET_INVALID' },
    });
    expect(publicationBody.data.activePointerEtag).toContain(fixture.snapshot2);
  });

  it('enforces canonical audit role/scope and per-action allowlist redaction', async () => {
    await expectProblem(get(editor, '/api/v1/admin/audit-events'), 403, 'ROLE_FORBIDDEN');
    const global = await get(
      systemAdmin,
      `/api/v1/admin/audit-events?action=feature.updated&resourceId=${fixture.feature1}&limit=1`,
    );
    expect(global.status).toBe(200);
    const globalBody =
      await json<Envelope<{ items: Array<Record<string, any>>; hasMore: boolean }>>(global);
    expect(globalBody.data.items).toHaveLength(1);
    expect(globalBody.data.items[0]!.metadata).toEqual({ revisionId: fixture.revision2 });
    expect(JSON.stringify(globalBody.data.items[0]!.metadata)).not.toMatch(
      /apiKey|code|hash|token/i,
    );

    const layerList = await get(editor, '/api/v1/admin/layers');
    const reordered = await post(
      editor,
      '/api/v1/admin/layers:reorder',
      {
        items: [
          { id: fixture.layerId, displayOrder: 31 },
          { id: fixture.otherLayerId, displayOrder: 32 },
        ],
      },
      { ifMatch: requiredHeader(layerList, 'etag'), idempotencyKey: randomUUID() },
    );
    expect(reordered.status).toBe(200);

    const roleCases = [
      { actor: editor, seesAuthoring: true, seesWorkflow: false },
      { actor: reviewer, seesAuthoring: false, seesWorkflow: true },
      { actor: publisher, seesAuthoring: false, seesWorkflow: true },
      { actor: systemAdmin, seesAuthoring: true, seesWorkflow: true },
    ];
    for (const { actor, seesAuthoring, seesWorkflow } of roleCases) {
      const scoped = await get(
        actor,
        `/api/v1/admin/layers/${fixture.layerId}/audit-events?limit=100`,
      );
      expect(scoped.status).toBe(200);
      const scopedBody = await json<Envelope<{ items: Array<Record<string, any>> }>>(scoped);
      expect(
        scopedBody.data.items.some(
          (item) => item.action === 'feature.updated' && item.resourceId === fixture.feature1,
        ),
      ).toBe(seesAuthoring);
      expect(scopedBody.data.items.some((item) => item.action === 'layer.reordered')).toBe(
        seesAuthoring,
      );
      expect(
        scopedBody.data.items.some(
          (item) => item.action === 'revision.approved' && item.resourceId === fixture.revision2,
        ),
      ).toBe(seesWorkflow);
      expect(
        scopedBody.data.items.every((item) => item.metadata.layerId !== fixture.otherLayerId),
      ).toBe(true);
      expect(scopedBody.data.items.some((item) => item.action.startsWith('auth.'))).toBe(false);
    }

    const cannotWiden = await get(
      reviewer,
      `/api/v1/admin/layers/${fixture.layerId}/audit-events?action=feature.updated&limit=100`,
    );
    expect(cannotWiden.status).toBe(200);
    expect((await json<Envelope<{ items: unknown[] }>>(cannotWiden)).data.items).toEqual([]);

    const explain = await AppDataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL enable_seqscan=off`);
      return manager.query(
        `EXPLAIN (COSTS OFF)
         SELECT audit.id
         FROM audit_layer_scopes scope
         JOIN audit_logs audit ON audit.id=scope.audit_id
         WHERE scope.layer_id=$1
         ORDER BY scope.occurred_at DESC,scope.audit_id DESC
         LIMIT 101`,
        [fixture.layerId],
      ) as Promise<Array<{ 'QUERY PLAN': string }>>;
    });
    expect(explain.map((line) => line['QUERY PLAN']).join('\n')).toContain(
      'idx_audit_layer_scope_cursor',
    );
    await expect(
      AppDataSource.query(
        `UPDATE audit_layer_scopes SET occurred_at=occurred_at WHERE layer_id=$1`,
        [fixture.layerId],
      ),
    ).rejects.toThrow(/immutable audit layer scope/i);
    await expect(
      AppDataSource.query(`DELETE FROM audit_layer_scopes WHERE layer_id=$1`, [fixture.layerId]),
    ).rejects.toThrow(/immutable audit layer scope/i);

    const events = await get(
      reviewer,
      `/api/v1/admin/revisions/${fixture.revision2}/workflow-events?limit=1`,
    );
    expect(events.status).toBe(200);
    const eventBody =
      await json<Envelope<{ items: unknown[]; hasMore: boolean; nextCursor: string }>>(events);
    expect(eventBody.data.items).toHaveLength(1);
    expect(eventBody.data.hasMore).toBe(true);
    expect(eventBody.data.nextCursor).toBeTruthy();
  });

  it('caps embedded revision child histories and reports explicit continuation state', async () => {
    await AppDataSource.query(
      `INSERT INTO workflow_events(revision_id,from_status,to_status,actor_id,reason,occurred_at)
       SELECT $1,'published','published',$2,'bounded fixture',now()-(value || ' seconds')::interval
       FROM generate_series(1,101) value`,
      [fixture.revision2, users.systemAdmin.id],
    );
    await AppDataSource.query(
      `INSERT INTO publication_snapshots(
         layer_id,revision_id,status,generation,feature_count,checksum,manifest,published_by,published_at
       )
       SELECT $1,$2,'published',1000+value,0,'bounded-'||value,'{}'::jsonb,$3,now()
       FROM generate_series(1,101) value`,
      [fixture.layerId, fixture.revision2, users.systemAdmin.id],
    );
    const response = await get(reviewer, `/api/v1/admin/revisions/${fixture.revision2}/history`);
    expect(response.status).toBe(200);
    const body = await json<
      Envelope<{
        events: unknown[];
        publications: unknown[];
        historyLimits: Record<string, { returned: number; hasMore: boolean; limit: number }>;
      }>
    >(response);
    expect(body.data.events).toHaveLength(100);
    expect(body.data.publications).toHaveLength(100);
    expect(body.data.historyLimits.events).toEqual({ returned: 100, hasMore: true, limit: 100 });
    expect(body.data.historyLimits.publications).toEqual({
      returned: 100,
      hasMore: true,
      limit: 100,
    });
  });

  it('rolls back atomically with exact replay and rejects stale, invalid and concurrent commands without side effects', async () => {
    const slugRows = (await AppDataSource.query(`SELECT slug FROM layers WHERE id=$1`, [
      fixture.layerId,
    ])) as Array<{ slug: string }>;
    const slug = slugRows[0]!.slug;
    const publicLayerUrl = `${apiBaseUrl}/api/v1/public/layers/${slug}`;
    const publicFeaturesUrl = `${publicLayerUrl}/features`;
    const primedLayer = await fetch(publicLayerUrl);
    const primedFeatures = await fetch(publicFeaturesUrl);
    expect(primedLayer.status).toBe(200);
    expect(primedFeatures.status).toBe(200);
    expect(primedLayer.headers.get('cache-control')).toBe('public, no-cache, must-revalidate');
    expect(primedFeatures.headers.get('cache-control')).toBe('public, no-cache, must-revalidate');
    const oldLayerEtag = requiredHeader(primedLayer, 'etag');
    const oldFeaturesEtag = requiredHeader(primedFeatures, 'etag');

    const firstPage = await get(
      publisher,
      `/api/v1/admin/layers/${fixture.layerId}/publications?limit=10`,
    );
    const firstPageBody = await json<Envelope<{ activePointerEtag: string }>>(firstPage);
    const initialEtag = firstPageBody.data.activePointerEtag;
    const invalidIntentBefore = await rollbackState();
    await expectProblem(
      post(
        publisher,
        `/api/v1/admin/layers/${fixture.layerId}:rollback`,
        { targetSnapshotId: fixture.snapshot1, reason: 'Missing client intent' },
        { idempotencyKey: randomUUID(), ifMatch: initialEtag },
      ),
      400,
      'BAD_REQUEST',
    );
    await expectProblem(
      postRollback(
        publisher,
        fixture.layerId,
        {
          targetSnapshotId: fixture.snapshot1,
          reason: 'Mobile client intent',
          clientIntent: 'mobile',
        },
        randomUUID(),
        initialEtag,
      ),
      400,
      'BAD_REQUEST',
    );
    expect(await rollbackState()).toEqual(invalidIntentBefore);

    const key = randomUUID();
    const body = {
      targetSnapshotId: fixture.snapshot1,
      reason: 'Khôi phục bản phát hành ổn định',
      clientIntent: 'desktop',
    };
    const before = await rollbackState();
    const rollback = await postRollback(publisher, fixture.layerId, body, key, initialEtag);
    const rollbackBody = await json<Envelope<Record<string, any>>>(rollback);
    if (rollback.status !== 201) {
      throw new Error(`rollback failed ${rollback.status}: ${JSON.stringify(rollbackBody)}`);
    }
    const rollbackEtag = requiredHeader(rollback, 'etag');
    expect(rollbackBody.data).toMatchObject({
      targetSnapshotId: fixture.snapshot1,
      status: 'completed',
    });
    const after = await rollbackState();
    expect(after).toMatchObject({
      snapshots: before.snapshots + 1,
      audits: before.audits + 1,
      receipts: before.receipts + 1,
      activeSnapshotId: rollbackBody.data.snapshotId,
    });
    const rollbackAudit = (await AppDataSource.query(
      `SELECT metadata->>'clientIntent' AS "clientIntent"
       FROM audit_logs WHERE action='publication.rolled_back' AND resource_id=$1`,
      [rollbackBody.data.snapshotId],
    )) as Array<{ clientIntent: string }>;
    expect(rollbackAudit).toEqual([{ clientIntent: 'desktop' }]);
    const revalidatedLayer = await fetch(publicLayerUrl, {
      headers: { 'If-None-Match': oldLayerEtag },
    });
    const revalidatedFeatures = await fetch(publicFeaturesUrl, {
      headers: { 'If-None-Match': oldFeaturesEtag },
    });
    expect(revalidatedLayer.status).toBe(200);
    expect(revalidatedFeatures.status).toBe(200);
    expect(requiredHeader(revalidatedLayer, 'etag')).not.toBe(oldLayerEtag);
    expect(requiredHeader(revalidatedFeatures, 'etag')).not.toBe(oldFeaturesEtag);
    expect((await json<Envelope<{ generation: number }>>(revalidatedLayer)).data.generation).toBe(
      rollbackBody.data.generation,
    );
    expect(
      (await json<{ meta: { generation: number } }>(revalidatedFeatures)).meta.generation,
    ).toBe(rollbackBody.data.generation);

    const replay = await postRollback(publisher, fixture.layerId, body, key, initialEtag);
    expect(replay.status).toBe(201);
    expect(requiredHeader(replay, 'etag')).toBe(rollbackEtag);
    expect((await json<Envelope<Record<string, any>>>(replay)).data).toEqual(rollbackBody.data);
    expect(await rollbackState()).toEqual(after);
    await expectProblem(
      postRollback(
        publisher,
        fixture.layerId,
        { ...body, reason: 'Payload khác' },
        key,
        initialEtag,
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(await rollbackState()).toEqual(after);

    await expectProblem(
      postRollback(
        publisher,
        fixture.layerId,
        { targetSnapshotId: fixture.snapshot2, reason: 'Stale' },
        randomUUID(),
        initialEtag,
      ),
      412,
      'ETAG_MISMATCH',
    );
    expect(await rollbackState()).toEqual(after);

    await expectProblem(
      postRollback(
        publisher,
        fixture.layerId,
        { targetSnapshotId: fixture.neverActivatedSnapshot, reason: 'Never active' },
        randomUUID(),
        rollbackEtag,
      ),
      404,
      'ROLLBACK_TARGET_NOT_FOUND',
    );
    expect(await rollbackState()).toEqual(after);

    const concurrentBefore = await rollbackState();
    const concurrent = await Promise.all([
      postRollback(
        publisher,
        fixture.layerId,
        { targetSnapshotId: fixture.snapshot2, reason: 'Concurrent A' },
        randomUUID(),
        rollbackEtag,
      ),
      postRollback(
        publisher,
        fixture.layerId,
        { targetSnapshotId: fixture.snapshot2, reason: 'Concurrent B' },
        randomUUID(),
        rollbackEtag,
      ),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 412]);
    const concurrentAfter = await rollbackState();
    expect(concurrentAfter).toMatchObject({
      snapshots: concurrentBefore.snapshots + 1,
      audits: concurrentBefore.audits + 1,
      receipts: concurrentBefore.receipts + 1,
    });

    const latestPage = await get(
      publisher,
      `/api/v1/admin/layers/${fixture.layerId}/publications?limit=10`,
    );
    const latest = await json<Envelope<{ activePointerEtag: string }>>(latestPage);
    const failureBefore = await rollbackState();
    const beforeFailurePublic = await fetch(publicLayerUrl);
    const beforeFailureFeatures = await fetch(publicFeaturesUrl);
    expect(beforeFailurePublic.status).toBe(200);
    expect(beforeFailureFeatures.status).toBe(200);
    const beforeFailurePublicEtag = requiredHeader(beforeFailurePublic, 'etag');
    const beforeFailureFeaturesEtag = requiredHeader(beforeFailureFeatures, 'etag');
    await installRollbackFailureTrigger();
    try {
      const failure = await postRollback(
        publisher,
        fixture.layerId,
        { targetSnapshotId: fixture.snapshot1, reason: 'Injected failure' },
        randomUUID(),
        latest.data.activePointerEtag,
      );
      expect(failure.status).toBe(500);
    } finally {
      await removeRollbackFailureTrigger();
    }
    expect(await rollbackState()).toEqual(failureBefore);
    const unchangedPublic = await fetch(publicLayerUrl, {
      headers: { 'If-None-Match': beforeFailurePublicEtag },
    });
    const unchangedFeatures = await fetch(publicFeaturesUrl, {
      headers: { 'If-None-Match': beforeFailureFeaturesEtag },
    });
    expect(unchangedPublic.status).toBe(304);
    expect(unchangedFeatures.status).toBe(304);
  });

  it('records edit participation at mutation time and keeps later publisher SoD denial side-effect free', async () => {
    const deletion = await createDeleteFixture();
    const deleted = await fetch(
      `${apiBaseUrl}/api/v1/admin/revisions/${deletion.revisionId}/features/${deletion.featureId}`,
      {
        method: 'DELETE',
        headers: mutationHeaders(editor, { ifMatch: `"rev-${deletion.revisionId}-v1"` }),
      },
    );
    expect(deleted.status).toBe(200);
    const deleteParticipants = (await AppDataSource.query(
      `SELECT participation_type FROM revision_participants WHERE revision_id=$1 AND user_id=$2`,
      [deletion.revisionId, users.editor.id],
    )) as Array<{ participation_type: string }>;
    expect(deleteParticipants).toEqual([{ participation_type: 'edit' }]);

    const sod = await createSodFixture();
    const update = await fetch(
      `${apiBaseUrl}/api/v1/admin/revisions/${sod.revisionId}/features/${sod.featureId}`,
      {
        method: 'PATCH',
        headers: mutationHeaders(editor, { ifMatch: `"rev-${sod.revisionId}-v1"` }),
        body: JSON.stringify({ properties: { name: 'editor mutation' } }),
      },
    );
    expect(update.status).toBe(200);
    const participants = (await AppDataSource.query(
      `SELECT participation_type FROM revision_participants WHERE revision_id=$1 AND user_id=$2`,
      [sod.revisionId, users.editor.id],
    )) as Array<{ participation_type: string }>;
    expect(participants.map((row) => row.participation_type)).toContain('edit');

    await AppDataSource.query(`UPDATE layer_revisions SET status='approved' WHERE id=$1`, [
      sod.revisionId,
    ]);
    await AppDataSource.query(`UPDATE users SET role='publisher' WHERE id=$1`, [users.editor.id]);
    const before = await sodState(sod.layerId);
    try {
      await expectProblem(
        post(
          editor,
          `/api/v1/admin/revisions/${sod.revisionId}:publish`,
          { releaseNote: 'Should be denied' },
          { idempotencyKey: randomUUID() },
        ),
        403,
        'SEPARATION_OF_DUTIES',
      );
      const page = await get(editor, `/api/v1/admin/layers/${sod.layerId}/publications?limit=10`);
      const pageBody = await json<Envelope<{ activePointerEtag: string }>>(page);
      await expectProblem(
        postRollback(
          editor,
          sod.layerId,
          { targetSnapshotId: sod.targetSnapshotId, reason: 'Should be denied' },
          randomUUID(),
          pageBody.data.activePointerEtag,
        ),
        403,
        'SEPARATION_OF_DUTIES',
      );
      expect(await sodState(sod.layerId)).toEqual(before);
    } finally {
      await AppDataSource.query(`UPDATE users SET role='editor' WHERE id=$1`, [users.editor.id]);
    }
  });

  it('rejects an oversized synchronous diff before unbounded comparison work', async () => {
    const oversized = await createOversizedDiffFixture();
    const response = await get(
      reviewer,
      `/api/v1/admin/revisions/${oversized.revisionId}/diff?compareTo=parent&limit=1`,
    );
    expect(response.status).toBe(422);
    const problem = (await response.json()) as {
      code: string;
      details: Record<string, unknown>;
    };
    expect(problem).toMatchObject({
      code: 'DIFF_TOO_LARGE',
      details: {
        reason: 'COMPLEXITY_LIMIT',
        currentFeatures: 25_001,
        maxFeaturesPerSide: 25_000,
      },
    });
  });

  it('publishes typed OpenAPI ETag and problem branches for all history operations', async () => {
    for (const path of [
      '/api/v1/admin/layers/not-a-uuid/history',
      '/api/v1/admin/revisions/not-a-uuid/history',
      '/api/v1/admin/revisions/not-a-uuid/diff',
      '/api/v1/admin/layers/not-a-uuid/publications',
      '/api/v1/admin/publications/not-a-uuid',
      '/api/v1/admin/layers/not-a-uuid/audit-events',
      '/api/v1/admin/revisions/not-a-uuid/workflow-events',
    ]) {
      await expectProblem(get(systemAdmin, path), 400, 'BAD_REQUEST');
    }
    await expectProblem(
      postRollback(
        publisher,
        'not-a-uuid',
        { targetSnapshotId: fixture.snapshot1, reason: 'Invalid layer id' },
        randomUUID(),
        '"publication-pointer-00000000-0000-4000-8000-000000000000-00000000-0000-4000-8000-000000000001-g1"',
      ),
      400,
      'BAD_REQUEST',
    );

    const passwordChangeBefore = await rollbackState();
    await AppDataSource.query(`UPDATE users SET must_change_password=true WHERE id=$1`, [
      users.publisher.id,
    ]);
    try {
      await expectProblem(
        get(publisher, `/api/v1/admin/layers/${fixture.layerId}/publications`),
        403,
        'PASSWORD_CHANGE_REQUIRED',
      );
      await expectProblem(
        postRollback(
          publisher,
          fixture.layerId,
          { targetSnapshotId: fixture.snapshot1, reason: 'Password change gate' },
          randomUUID(),
          '"publication-pointer-00000000-0000-4000-8000-000000000000-00000000-0000-4000-8000-000000000001-g1"',
        ),
        403,
        'PASSWORD_CHANGE_REQUIRED',
      );
      expect(await rollbackState()).toEqual(passwordChangeBefore);
    } finally {
      await AppDataSource.query(`UPDATE users SET must_change_password=false WHERE id=$1`, [
        users.publisher.id,
      ]);
    }

    const response = await fetch(`${apiBaseUrl}/api/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as any;
    const operationIds = new Set<string>();
    for (const path of Object.values(document.paths) as Array<Record<string, any>>) {
      for (const operation of Object.values(path))
        if (operation?.operationId) operationIds.add(operation.operationId);
    }
    for (const operationId of [
      'listLayerRevisionHistory',
      'getRevisionHistory',
      'getRevisionDiff',
      'listLayerPublicationHistory',
      'getPublicationHistory',
      'listAuditEvents',
      'listLayerAuditEvents',
      'listRevisionWorkflowEvents',
      'rollbackLayer',
    ])
      expect(operationIds).toContain(operationId);
    const rollback = document.paths['/api/v1/admin/layers/{layerId}:rollback'].post;
    expect(rollback.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'If-Match', in: 'header', required: true }),
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]),
    );
    expect(Object.keys(rollback.responses)).toEqual(
      expect.arrayContaining(['201', '400', '403', '409', '412', '428']),
    );
    expect(rollback.responses['201'].headers.ETag).toBeDefined();
    expect(
      rollback.responses['400'].content['application/problem+json'].schema.properties.code.enum,
    ).toEqual(expect.arrayContaining(['BAD_REQUEST', 'VALIDATION_FAILED']));
    expect(
      rollback.responses['403'].content['application/problem+json'].schema.properties.code.enum,
    ).toEqual(expect.arrayContaining(['PASSWORD_CHANGE_REQUIRED', 'SEPARATION_OF_DUTIES']));
    expect(document.components.schemas.RollbackDto.required).toEqual(
      expect.arrayContaining(['targetSnapshotId', 'reason', 'clientIntent']),
    );
    expect(document.components.schemas.RollbackDto.properties.clientIntent.enum).toEqual([
      'desktop',
    ]);
    const diff = document.paths['/api/v1/admin/revisions/{revisionId}/diff'].get;
    expect(Object.keys(diff.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '422']),
    );
    expect(diff.responses['200'].headers.ETag).toBeDefined();
    const uuidParamOperations = [
      document.paths['/api/v1/admin/layers/{layerId}/history'].get,
      document.paths['/api/v1/admin/revisions/{revisionId}/history'].get,
      diff,
      document.paths['/api/v1/admin/layers/{layerId}/publications'].get,
      document.paths['/api/v1/admin/publications/{snapshotId}'].get,
      document.paths['/api/v1/admin/layers/{layerId}/audit-events'].get,
      document.paths['/api/v1/admin/revisions/{revisionId}/workflow-events'].get,
    ];
    for (const operation of uuidParamOperations) {
      expect(
        operation.responses['400'].content['application/problem+json'].schema.properties.code.enum,
      ).toContain('BAD_REQUEST');
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(['200', '400', '401', '403']),
      );
    }
  });

  async function rollbackState() {
    const rows = (await AppDataSource.query(
      `SELECT
        (SELECT count(*)::integer FROM publication_snapshots WHERE layer_id=$1) AS snapshots,
        (SELECT active_snapshot_id FROM layer_publications WHERE layer_id=$1) AS "activeSnapshotId",
        (SELECT snapshot.generation::integer
           FROM layer_publications pointer
           JOIN publication_snapshots snapshot ON snapshot.id=pointer.active_snapshot_id
           WHERE pointer.layer_id=$1) AS "activeGeneration",
        (SELECT count(*)::integer FROM audit_logs WHERE action='publication.rolled_back'
           AND resource_id IN (SELECT id FROM publication_snapshots WHERE layer_id=$1)) AS audits,
        (SELECT count(*)::integer FROM command_receipts WHERE actor_id=$2 AND operation='layer.rollback') AS receipts`,
      [fixture.layerId, users.publisher.id],
    )) as Array<{
      snapshots: number;
      activeSnapshotId: string;
      activeGeneration: number;
      audits: number;
      receipts: number;
    }>;
    return rows[0]!;
  }
});

async function createFixture(): Promise<Fixture> {
  const ids = {
    groupId: randomUUID(),
    layerId: randomUUID(),
    otherLayerId: randomUUID(),
    revision1: randomUUID(),
    revision2: randomUUID(),
    otherRevision: randomUUID(),
    feature1: randomUUID(),
    feature2: randomUUID(),
    feature3: randomUUID(),
    otherFeature: randomUUID(),
    snapshot1: randomUUID(),
    snapshot2: randomUUID(),
    neverActivatedSnapshot: randomUUID(),
    attachmentIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
  };
  await AppDataSource.transaction(async (manager) => {
    const suffix = randomUUID().slice(0, 8);
    await manager.query(`INSERT INTO layer_groups(id,slug,title) VALUES($1,$2,'History tests')`, [
      ids.groupId,
      `history-${suffix}`,
    ]);
    await manager.query(
      `INSERT INTO layers(id,slug,group_id,created_by) VALUES($1,$2,$3,$4),($5,$6,$3,$4)`,
      [
        ids.layerId,
        `history-a-${suffix}`,
        ids.groupId,
        users.editor.id,
        ids.otherLayerId,
        `history-b-${suffix}`,
      ],
    );
    await manager.query(
      `INSERT INTO layer_revisions(id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,created_by,supersedes_revision_id,published_at)
       VALUES($1,$2,1,'published','Revision 1','mixed',ARRAY['point','circle','line','polygon'],$6,NULL,now()-interval '2 hour'),
             ($3,$2,2,'published','Revision 2','mixed',ARRAY['point','circle','line','polygon'],$6,$1,now()-interval '1 hour'),
             ($4,$5,1,'published','Other revision','point',ARRAY['point'],$6,NULL,now())`,
      [
        ids.revision1,
        ids.layerId,
        ids.revision2,
        ids.otherRevision,
        ids.otherLayerId,
        users.editor.id,
      ],
    );
    for (const revisionId of [ids.revision1, ids.revision2]) {
      await manager.query(
        `INSERT INTO layer_fields(revision_id,key,label,type,public,sensitive,offline_cache,display_order)
         VALUES($1,'name','Name','text',true,false,true,1),
               ($1,'secret','Secret','text',false,true,false,2),
               ($1,'documents','Documents','attachment',true,false,true,3),
               ($1,'private_documents','Private documents','attachment',false,true,false,4)`,
        [revisionId],
      );
    }
    await manager.query(`INSERT INTO features(id,layer_id) VALUES($1,$4),($2,$4),($3,$4),($5,$6)`, [
      ids.feature1,
      ids.feature2,
      ids.feature3,
      ids.layerId,
      ids.otherFeature,
      ids.otherLayerId,
    ]);
    const versions = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await manager.query(
      `INSERT INTO feature_versions(id,feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by)
       VALUES
       ($1,$6,$10,ST_SetSRID(ST_MakePoint(108.2,16.0),4326),'circle',$14::jsonb,100,'private-checksum-before',$13),
       ($2,$6,$11,ST_SetSRID(ST_MakePoint(108.21,16.01),4326),'circle',$15::jsonb,200,'private-checksum-after',$13),
       ($3,$7,$10,ST_SetSRID(ST_MakePoint(108.3,16.1),4326),'point',$16::jsonb,NULL,'removed-private-checksum',$13),
       ($4,$8,$11,ST_Buffer(ST_SetSRID(ST_MakePoint(108.4,16.2),4326),0.01,'quad_segs=128'),'polygon',$17::jsonb,NULL,'added-private-checksum',$13),
       ($5,$9,$12,ST_SetSRID(ST_MakePoint(108.5,16.3),4326),'point','{}'::jsonb,NULL,'other',$13)`,
      [
        ...versions,
        ids.feature1,
        ids.feature2,
        ids.feature3,
        ids.otherFeature,
        ids.revision1,
        ids.revision2,
        ids.otherRevision,
        users.editor.id,
        JSON.stringify({
          name: 'before',
          secret: 'private-before',
          documents: ['storage-key-before'],
        }),
        JSON.stringify({
          name: 'after',
          secret: 'private-after',
          documents: ['storage-key-after'],
        }),
        JSON.stringify({ name: 'removed', secret: 'private-removed' }),
        JSON.stringify({ name: 'added', secret: 'private-added' }),
      ],
    );
    await manager.query(
      `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
       VALUES($1,$3,$5,1),($1,$4,$7,2),($2,$3,$6,1),($2,$8,$9,2),($10,$11,$12,1)`,
      [
        ids.revision1,
        ids.revision2,
        ids.feature1,
        ids.feature2,
        versions[0],
        versions[1],
        versions[2],
        ids.feature3,
        versions[3],
        ids.otherRevision,
        ids.otherFeature,
        versions[4],
      ],
    );
    await manager.query(
      `INSERT INTO attachments(
         id,quarantine_key,object_key,file_name,declared_content_type,content_type,
         declared_size_bytes,size_bytes,declared_sha256,sha256,status,owner_id,
         upload_expires_at,finalized_at,scanned_at
       ) VALUES
         ($1,$6,$7,'shared-public.pdf','application/pdf','application/pdf',11,11,repeat('a',64),repeat('a',64),'clean',$11,now()+interval '1 hour',now(),now()),
         ($2,$8,$9,'removed-public.pdf','application/pdf','application/pdf',12,12,repeat('b',64),repeat('b',64),'clean',$11,now()+interval '1 hour',now(),now()),
         ($3,$10,$12,'added-public.pdf','application/pdf','application/pdf',13,13,repeat('c',64),repeat('c',64),'clean',$11,now()+interval '1 hour',now(),now()),
         ($4,$13,$14,'private-attachment-before.pdf','application/pdf','application/pdf',14,14,repeat('d',64),repeat('d',64),'clean',$11,now()+interval '1 hour',now(),now()),
         ($5,$15,$16,'private-attachment-after.pdf','application/pdf','application/pdf',15,15,repeat('e',64),repeat('e',64),'clean',$11,now()+interval '1 hour',now(),now())`,
      [
        ...ids.attachmentIds,
        `history-quarantine/${ids.attachmentIds[0]}`,
        `history-storage/${ids.attachmentIds[0]}`,
        `history-quarantine/${ids.attachmentIds[1]}`,
        `history-storage/${ids.attachmentIds[1]}`,
        `history-quarantine/${ids.attachmentIds[2]}`,
        users.editor.id,
        `history-storage/${ids.attachmentIds[2]}`,
        `history-quarantine/${ids.attachmentIds[3]}`,
        `history-storage/${ids.attachmentIds[3]}`,
        `history-quarantine/${ids.attachmentIds[4]}`,
        `history-storage/${ids.attachmentIds[4]}`,
      ],
    );
    await manager.query(
      `INSERT INTO feature_version_attachments(
         feature_version_id,attachment_id,field_key,display_order
       ) VALUES
         ($1,$3,'documents',0),($1,$4,'documents',1),
         ($1,$6,'private_documents',0),
         ($2,$3,'documents',1),($2,$5,'documents',2),
         ($2,$7,'private_documents',0)`,
      [versions[0], versions[1], ...ids.attachmentIds],
    );
    await manager.query(
      `INSERT INTO publication_snapshots(id,layer_id,revision_id,status,generation,feature_count,checksum,manifest,published_by,published_at,activated_at)
       VALUES($1,$4,$5,'published',1,2,'s1','{}',$7,now()-interval '2 hour',now()-interval '2 hour'),
             ($2,$4,$6,'published',2,2,'s2','{}',$7,now()-interval '1 hour',now()-interval '1 hour'),
             ($3,$4,$6,'published',3,2,'never','{}',$7,now(),NULL)`,
      [
        ids.snapshot1,
        ids.snapshot2,
        ids.neverActivatedSnapshot,
        ids.layerId,
        ids.revision1,
        ids.revision2,
        users.systemAdmin.id,
      ],
    );
    await manager.query(
      `INSERT INTO layer_publications(layer_id,active_snapshot_id,previous_snapshot_id) VALUES($1,$2,$3)`,
      [ids.layerId, ids.snapshot2, ids.snapshot1],
    );
    await manager.query(
      `INSERT INTO workflow_events(revision_id,from_status,to_status,actor_id,reason,occurred_at)
       VALUES($1,'draft','in_review',$2,'submit',now()-interval '3 minute'),
             ($1,'in_review','approved',$3,'approve',now()-interval '2 minute'),
             ($1,'approved','published',$4,'publish',now()-interval '1 minute')`,
      [ids.revision2, users.editor.id, users.reviewer.id, users.systemAdmin.id],
    );
    await manager.query(
      `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata,occurred_at)
       VALUES($1,'editor','feature.updated','feature',$2,$3,$4::jsonb,now()-interval '2 minute'),
             ($1,'editor','feature.updated','feature',$5,$6,$7::jsonb,now()-interval '1 minute'),
             ($8,'system_admin','auth.login_succeeded','user',$8,$9,$10::jsonb,now())`,
      [
        users.editor.id,
        ids.feature1,
        randomUUID(),
        JSON.stringify({
          revisionId: ids.revision2,
          apiKey: 'drop',
          code: 'drop',
          hash: 'drop',
          token: 'drop',
        }),
        ids.otherFeature,
        randomUUID(),
        JSON.stringify({ revisionId: ids.otherRevision, layerId: ids.otherLayerId }),
        users.systemAdmin.id,
        randomUUID(),
        JSON.stringify({ method: 'password', apiKey: 'drop' }),
      ],
    );
    await manager.query(
      `INSERT INTO audit_logs(
         actor_id,actor_role,action,resource_type,resource_id,request_id,metadata,occurred_at
       ) VALUES($1,'reviewer','revision.approved','revision',$2,$3,$4::jsonb,now()-interval '30 second')`,
      [
        users.reviewer.id,
        ids.revision2,
        randomUUID(),
        JSON.stringify({ comment: 'Approved fixture', apiKey: 'drop' }),
      ],
    );
  });
  createdLayerIds.push(ids.layerId, ids.otherLayerId);
  return ids;
}

async function createSodFixture() {
  const layerId = randomUUID();
  const revisionId = randomUUID();
  const activeRevisionId = randomUUID();
  const featureId = randomUUID();
  const versionId = randomUUID();
  const targetSnapshotId = randomUUID();
  const activeSnapshotId = randomUUID();
  const groupRows = (await AppDataSource.query(`SELECT id FROM layer_groups LIMIT 1`)) as Array<{
    id: string;
  }>;
  await AppDataSource.transaction(async (manager) => {
    await manager.query(`INSERT INTO layers(id,slug,group_id,created_by) VALUES($1,$2,$3,$4)`, [
      layerId,
      `sod-${randomUUID().slice(0, 8)}`,
      groupRows[0]!.id,
      users.editor.id,
    ]);
    await manager.query(
      `INSERT INTO layer_revisions(id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,created_by,supersedes_revision_id,published_at)
       VALUES($1,$3,1,'draft','SoD target','point',ARRAY['point'],$4,NULL,NULL),
             ($2,$3,2,'published','SoD active','point',ARRAY['point'],$4,$1,now())`,
      [revisionId, activeRevisionId, layerId, users.systemAdmin.id],
    );
    await manager.query(
      `INSERT INTO layer_fields(revision_id,key,label,type) VALUES($1,'name','Name','text')`,
      [revisionId],
    );
    await manager.query(`INSERT INTO features(id,layer_id) VALUES($1,$2)`, [featureId, layerId]);
    await manager.query(
      `INSERT INTO feature_versions(id,feature_id,revision_id,geometry,geometry_kind,properties,checksum,created_by) VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint(108.2,16),4326),'point','{"name":"before"}','before',$4)`,
      [versionId, featureId, revisionId, users.systemAdmin.id],
    );
    await manager.query(
      `INSERT INTO revision_features(revision_id,feature_id,feature_version_id) VALUES($1,$2,$3)`,
      [revisionId, featureId, versionId],
    );
    await manager.query(
      `INSERT INTO publication_snapshots(id,layer_id,revision_id,status,generation,checksum,manifest,published_by,published_at,activated_at)
       VALUES($1,$3,$4,'published',1,'target','{}',$6,now()-interval '1 hour',now()-interval '1 hour'),
             ($2,$3,$5,'published',2,'active','{}',$6,now(),now())`,
      [
        targetSnapshotId,
        activeSnapshotId,
        layerId,
        revisionId,
        activeRevisionId,
        users.systemAdmin.id,
      ],
    );
    await manager.query(
      `INSERT INTO layer_publications(layer_id,active_snapshot_id,previous_snapshot_id) VALUES($1,$2,$3)`,
      [layerId, activeSnapshotId, targetSnapshotId],
    );
  });
  createdLayerIds.push(layerId);
  return { layerId, revisionId, featureId, targetSnapshotId };
}

async function createDeleteFixture() {
  const layerId = randomUUID();
  const revisionId = randomUUID();
  const featureId = randomUUID();
  const versionId = randomUUID();
  const groupRows = (await AppDataSource.query(`SELECT id FROM layer_groups LIMIT 1`)) as Array<{
    id: string;
  }>;
  await AppDataSource.transaction(async (manager) => {
    await manager.query(`INSERT INTO layers(id,slug,group_id,created_by) VALUES($1,$2,$3,$4)`, [
      layerId,
      `delete-sod-${randomUUID().slice(0, 8)}`,
      groupRows[0]!.id,
      users.editor.id,
    ]);
    await manager.query(
      `INSERT INTO layer_revisions(id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,created_by)
       VALUES($1,$2,1,'draft','Delete participation','point',ARRAY['point'],$3)`,
      [revisionId, layerId, users.editor.id],
    );
    await manager.query(
      `INSERT INTO layer_fields(revision_id,key,label,type) VALUES($1,'name','Name','text')`,
      [revisionId],
    );
    await manager.query(`INSERT INTO features(id,layer_id) VALUES($1,$2)`, [featureId, layerId]);
    await manager.query(
      `INSERT INTO feature_versions(id,feature_id,revision_id,geometry,geometry_kind,properties,checksum,created_by)
       VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint(108.2,16),4326),'point','{"name":"delete"}','delete',$4)`,
      [versionId, featureId, revisionId, users.editor.id],
    );
    await manager.query(
      `INSERT INTO revision_features(revision_id,feature_id,feature_version_id) VALUES($1,$2,$3)`,
      [revisionId, featureId, versionId],
    );
  });
  createdLayerIds.push(layerId);
  return { layerId, revisionId, featureId };
}

async function createOversizedDiffFixture() {
  const layerId = randomUUID();
  const revisionId = randomUUID();
  const groupRows = (await AppDataSource.query(`SELECT id FROM layer_groups LIMIT 1`)) as Array<{
    id: string;
  }>;
  await AppDataSource.transaction(async (manager) => {
    await manager.query(`INSERT INTO layers(id,slug,group_id,created_by) VALUES($1,$2,$3,$4)`, [
      layerId,
      `diff-limit-${randomUUID().slice(0, 8)}`,
      groupRows[0]!.id,
      users.editor.id,
    ]);
    await manager.query(
      `INSERT INTO layer_revisions(id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,created_by)
       VALUES($1,$2,1,'draft','Oversized diff','point',ARRAY['point'],$3)`,
      [revisionId, layerId, users.editor.id],
    );
    await manager.query(
      `WITH created_features AS (
         INSERT INTO features(layer_id)
         SELECT $1::uuid FROM generate_series(1,25001)
         RETURNING id
       ), created_versions AS (
         INSERT INTO feature_versions(feature_id,revision_id,geometry,geometry_kind,properties,checksum,created_by)
         SELECT id,$2::uuid,ST_SetSRID(ST_MakePoint(108.2,16),4326),'point','{}'::jsonb,id::text,$3::uuid
         FROM created_features
         RETURNING id,feature_id
       )
       INSERT INTO revision_features(revision_id,feature_id,feature_version_id)
       SELECT $2::uuid,feature_id,id FROM created_versions`,
      [layerId, revisionId, users.editor.id],
    );
  });
  createdLayerIds.push(layerId);
  return { layerId, revisionId };
}

async function sodState(layerId: string) {
  const rows = (await AppDataSource.query(
    `SELECT (SELECT count(*)::integer FROM publication_snapshots WHERE layer_id=$1) snapshots,
            (SELECT active_snapshot_id FROM layer_publications WHERE layer_id=$1) "activeSnapshotId",
            (SELECT count(*)::integer FROM audit_logs WHERE action IN ('revision.published','publication.rolled_back') AND occurred_at>=now()-interval '5 minute') audits,
            (SELECT count(*)::integer FROM command_receipts WHERE actor_id=$2 AND operation IN ('revision.publish','layer.rollback')) receipts`,
    [layerId, users.editor.id],
  )) as Array<Record<string, unknown>>;
  return rows[0]!;
}

async function installRollbackFailureTrigger() {
  await AppDataSource.query(
    `CREATE OR REPLACE FUNCTION test_reject_rollback_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.manifest ? 'rollbackOf' THEN RAISE EXCEPTION 'injected rollback failure'; END IF; RETURN NEW; END $$`,
  );
  await AppDataSource.query(
    `CREATE TRIGGER trg_test_rollback_failure BEFORE INSERT ON publication_snapshots FOR EACH ROW EXECUTE FUNCTION test_reject_rollback_snapshot()`,
  );
}
async function removeRollbackFailureTrigger() {
  await AppDataSource.query(
    `DROP TRIGGER IF EXISTS trg_test_rollback_failure ON publication_snapshots`,
  );
  await AppDataSource.query(`DROP FUNCTION IF EXISTS test_reject_rollback_snapshot()`);
}

async function get(actor: Actor, path: string) {
  return fetch(`${apiBaseUrl}${path}`, { headers: { Cookie: actor.cookie } });
}
async function post(
  actor: Actor,
  path: string,
  body: Record<string, unknown>,
  options: { idempotencyKey?: string; ifMatch?: string } = {},
) {
  return fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: mutationHeaders(actor, options),
    body: JSON.stringify(body),
  });
}
async function postRollback(
  actor: Actor,
  layerId: string,
  body: Record<string, unknown>,
  key: string,
  etag: string,
) {
  return post(
    actor,
    `/api/v1/admin/layers/${layerId}:rollback`,
    { clientIntent: 'desktop', ...body },
    {
      idempotencyKey: key,
      ifMatch: etag,
    },
  );
}

function mutationHeaders(
  actor: Actor,
  options: { idempotencyKey?: string; ifMatch?: string } = {},
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Cookie: actor.cookie,
    Origin: frontendOrigin,
    'X-CSRF-Token': actor.csrf,
    ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
  };
}

async function expectProblem(responsePromise: Promise<Response>, status: number, code: string) {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ status, code });
}
function requiredHeader(response: Response, name: string) {
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
  const token = (await json<Envelope<{ csrfToken: string }>>(csrfResponse)).data.csrfToken;
  const csrfCookie = cookieValue(csrfResponse, 'danangmap_csrf');
  const loginResponse = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `danangmap_csrf=${csrfCookie}`,
      Origin: frontendOrigin,
      'X-CSRF-Token': token,
    },
    body: JSON.stringify({ login: user.login, password: user.password }),
  });
  expect(loginResponse.status).toBe(200);
  const preauth = cookieValue(loginResponse, E2E_PREAUTH_COOKIE);
  const preCsrf = cookieValue(loginResponse, 'danangmap_csrf');
  const verify = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${E2E_PREAUTH_COOKIE}=${preauth}; danangmap_csrf=${preCsrf}`,
      Origin: frontendOrigin,
      'X-CSRF-Token': preCsrf,
    },
    body: JSON.stringify({ method: 'totp', code: totp(mfaSecret) }),
  });
  expect(verify.status).toBe(200);
  const session = cookieValue(verify, E2E_SESSION_COOKIE);
  let csrf = cookieValue(verify, 'danangmap_csrf');
  const rotate = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: { Cookie: `${E2E_SESSION_COOKIE}=${session}; danangmap_csrf=${csrf}` },
  });
  expect(rotate.status).toBe(200);
  csrf = (await json<Envelope<{ csrfToken: string }>>(rotate)).data.csrfToken;
  return { cookie: `${E2E_SESSION_COOKIE}=${session}; danangmap_csrf=${csrf}`, csrf };
}
function cookieValue(response: Response, name: string) {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  if (!match?.[1]) throw new Error(`Missing ${name}`);
  return match[1];
}
function totp(secret: string, epoch = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epoch / 30000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary =
    ((digest[offset]! & 127) << 24) |
    ((digest[offset + 1]! & 255) << 16) |
    ((digest[offset + 2]! & 255) << 8) |
    (digest[offset + 3]! & 255);
  return String(binary % 1000000).padStart(6, '0');
}
function decodeBase32(value: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.toUpperCase().replaceAll('=', '')) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid Base32');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8)
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}
