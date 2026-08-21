import { createHmac, randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';

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

interface AuthenticatedActor {
  id: string;
  cookie: string;
  csrf: string;
}

interface Envelope<T> {
  data: T;
  meta: { requestId: string };
}

describe('Dynamic layer lifecycle HTTP E2E', () => {
  const startedAt = new Date();
  const groupIds: string[] = [];
  const layerIds: string[] = [];
  const revisionIds: string[] = [];
  let editor: AuthenticatedActor;
  let reviewer: AuthenticatedActor;
  let publisher: AuthenticatedActor;
  let systemAdmin: AuthenticatedActor;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])',
      [Object.values(users).map((user) => user.id)],
    );
    [editor, reviewer, publisher, systemAdmin] = await Promise.all([
      login(users.editor),
      login(users.reviewer),
      login(users.publisher),
      login(users.systemAdmin),
    ]);
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query(
        'ALTER TABLE workflow_events DISABLE TRIGGER trg_workflow_events_immutable',
      );
      await manager.query(
        `DELETE FROM command_receipts
         WHERE actor_id=ANY($1::uuid[]) AND created_at >= $2`,
        [Object.values(users).map((user) => user.id), startedAt],
      );
      if (revisionIds.length) {
        await manager.query('DELETE FROM workflow_events WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM revision_participants WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM revision_changes WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM revision_features WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM feature_versions WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM layer_fields WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
      }
      if (layerIds.length) {
        await manager.query('DELETE FROM layer_publications WHERE layer_id=ANY($1::uuid[])', [
          layerIds,
        ]);
        await manager.query('DELETE FROM publication_snapshots WHERE layer_id=ANY($1::uuid[])', [
          layerIds,
        ]);
        await manager.query('DELETE FROM features WHERE layer_id=ANY($1::uuid[])', [layerIds]);
        await manager.query('DELETE FROM layer_revisions WHERE layer_id=ANY($1::uuid[])', [
          layerIds,
        ]);
        await manager.query('DELETE FROM layers WHERE id=ANY($1::uuid[])', [layerIds]);
      }
      if (groupIds.length) {
        await manager.query('DELETE FROM layer_groups WHERE id=ANY($1::uuid[])', [groupIds]);
      }
      await manager.query(
        `DELETE FROM audit_logs
         WHERE actor_id=ANY($1::uuid[]) AND occurred_at >= $2`,
        [Object.values(users).map((user) => user.id), startedAt],
      );
      await manager.query(
        `DELETE FROM admin_sessions
         WHERE user_id=ANY($1::uuid[]) AND created_at >= $2`,
        [Object.values(users).map((user) => user.id), startedAt],
      );
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

  it('updates, reorders and archives groups/layers with strict ETags and explicit role denies', async () => {
    const suffix = randomUUID().slice(0, 8);
    const firstGroup = await createGroup(`lifecycle-a-${suffix}`, 'Nhóm A', 30);
    const secondGroup = await createGroup(`lifecycle-b-${suffix}`, 'Nhóm B', 40);
    const firstLayer = await createLayer(
      `lifecycle-a-${suffix}`,
      firstGroup.data.id,
      'Layer A',
      30,
    );
    const secondLayer = await createLayer(
      `lifecycle-b-${suffix}`,
      secondGroup.data.id,
      'Layer B',
      40,
    );

    for (const actor of [reviewer, publisher, systemAdmin]) {
      await expectProblem(
        mutate(
          actor,
          `/api/v1/admin/layer-groups/${firstGroup.data.id}`,
          { title: 'Bị chặn' },
          {
            method: 'PATCH',
            ifMatch: firstGroup.etag,
            idempotencyKey: randomUUID(),
          },
        ),
        403,
        'ROLE_FORBIDDEN',
      );
    }

    const updateKey = randomUUID();
    const updatedGroupResponse = await mutate(
      editor,
      `/api/v1/admin/layer-groups/${firstGroup.data.id}`,
      { title: 'Nhóm A đã cập nhật', description: null, defaultVisible: false },
      { method: 'PATCH', ifMatch: firstGroup.etag, idempotencyKey: updateKey },
    );
    expect(updatedGroupResponse.status).toBe(200);
    const updatedGroup = (
      await json<Envelope<{ id: string; lockVersion: number; title: string }>>(updatedGroupResponse)
    ).data;
    const updatedGroupEtag = requiredHeader(updatedGroupResponse, 'etag');
    expect(updatedGroup).toMatchObject({ title: 'Nhóm A đã cập nhật', lockVersion: 2 });
    const updateReplay = await mutate(
      editor,
      `/api/v1/admin/layer-groups/${firstGroup.data.id}`,
      { title: 'Nhóm A đã cập nhật', description: null, defaultVisible: false },
      { method: 'PATCH', ifMatch: firstGroup.etag, idempotencyKey: updateKey },
    );
    expect(requiredHeader(updateReplay, 'etag')).toBe(updatedGroupEtag);
    await expectProblem(
      mutate(
        editor,
        `/api/v1/admin/layer-groups/${firstGroup.data.id}`,
        { title: 'Payload khác cho cùng key' },
        { method: 'PATCH', ifMatch: firstGroup.etag, idempotencyKey: updateKey },
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await expectProblem(
      mutate(
        editor,
        `/api/v1/admin/layer-groups/${firstGroup.data.id}`,
        { title: 'Stale' },
        {
          method: 'PATCH',
          ifMatch: firstGroup.etag,
          idempotencyKey: randomUUID(),
        },
      ),
      412,
      'ETAG_MISMATCH',
    );

    const groupsList = await adminGet('/api/v1/admin/layer-groups');
    const groupsListEtag = requiredHeader(groupsList, 'etag');
    const reorderGroupKey = randomUUID();
    const reorderedGroups = await mutate(
      editor,
      '/api/v1/admin/layer-groups:reorder',
      {
        items: [
          { id: firstGroup.data.id, displayOrder: 80 },
          { id: secondGroup.data.id, displayOrder: 70 },
        ],
      },
      { ifMatch: groupsListEtag, idempotencyKey: reorderGroupKey },
    );
    expect(reorderedGroups.status).toBe(200);
    const reorderedGroupsEtag = requiredHeader(reorderedGroups, 'etag');
    const reorderedGroupsReplay = await mutate(
      editor,
      '/api/v1/admin/layer-groups:reorder',
      {
        items: [
          { id: firstGroup.data.id, displayOrder: 80 },
          { id: secondGroup.data.id, displayOrder: 70 },
        ],
      },
      { ifMatch: groupsListEtag, idempotencyKey: reorderGroupKey },
    );
    expect(requiredHeader(reorderedGroupsReplay, 'etag')).toBe(reorderedGroupsEtag);
    await expectProblem(
      mutate(
        editor,
        '/api/v1/admin/layer-groups:reorder',
        { items: [{ id: firstGroup.data.id, displayOrder: 81 }] },
        { ifMatch: groupsListEtag, idempotencyKey: reorderGroupKey },
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await expectProblem(
      mutate(
        editor,
        '/api/v1/admin/layer-groups:reorder',
        { items: [{ id: firstGroup.data.id, displayOrder: 1 }] },
        { ifMatch: groupsListEtag, idempotencyKey: randomUUID() },
      ),
      412,
      'ETAG_MISMATCH',
    );

    const secondLayerDetail = await adminGet(`/api/v1/admin/layers/${secondLayer.layer.id}`);
    const moveLayerKey = randomUUID();
    const movedLayer = await mutate(
      editor,
      `/api/v1/admin/layers/${secondLayer.layer.id}`,
      { groupId: firstGroup.data.id, displayOrder: 85, defaultVisible: false },
      {
        method: 'PATCH',
        ifMatch: requiredHeader(secondLayerDetail, 'etag'),
        idempotencyKey: moveLayerKey,
      },
    );
    expect(movedLayer.status).toBe(200);
    expect(
      (await json<Envelope<{ layer: Record<string, unknown> }>>(movedLayer)).data.layer,
    ).toMatchObject({
      groupId: firstGroup.data.id,
      displayOrder: 85,
      defaultVisible: false,
    });
    await expectProblem(
      mutate(
        editor,
        `/api/v1/admin/layers/${secondLayer.layer.id}`,
        { displayOrder: 86 },
        {
          method: 'PATCH',
          ifMatch: requiredHeader(secondLayerDetail, 'etag'),
          idempotencyKey: moveLayerKey,
        },
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );

    const currentFirstGroup = await adminGet(`/api/v1/admin/layer-groups/${firstGroup.data.id}`);
    const archiveGroupKey = randomUUID();
    const archivedGroup = await mutate(
      editor,
      `/api/v1/admin/layer-groups/${firstGroup.data.id}:archive`,
      { orphanLayerPolicy: 'ungroup' },
      {
        ifMatch: requiredHeader(currentFirstGroup, 'etag'),
        idempotencyKey: archiveGroupKey,
      },
    );
    expect(archivedGroup.status).toBe(200);
    expect(
      (await json<Envelope<{ archivedAt: string | null }>>(archivedGroup)).data.archivedAt,
    ).toBeTruthy();
    const archivedGroupReplay = await mutate(
      editor,
      `/api/v1/admin/layer-groups/${firstGroup.data.id}:archive`,
      { orphanLayerPolicy: 'ungroup' },
      {
        ifMatch: requiredHeader(currentFirstGroup, 'etag'),
        idempotencyKey: archiveGroupKey,
      },
    );
    expect(requiredHeader(archivedGroupReplay, 'etag')).toBe(requiredHeader(archivedGroup, 'etag'));
    await expectProblem(
      mutate(
        editor,
        `/api/v1/admin/layer-groups/${firstGroup.data.id}:archive`,
        { orphanLayerPolicy: 'ungroup' },
        { ifMatch: requiredHeader(archivedGroup, 'etag'), idempotencyKey: archiveGroupKey },
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    const [ungroupedFirstLayer, ungroupedSecondLayer] = await Promise.all([
      adminGet(`/api/v1/admin/layers/${firstLayer.layer.id}`),
      adminGet(`/api/v1/admin/layers/${secondLayer.layer.id}`),
    ]);
    expect(
      (await json<Envelope<{ layer: { groupId: string | null } }>>(ungroupedFirstLayer)).data.layer
        .groupId,
    ).toBeNull();
    expect(
      (await json<Envelope<{ layer: { groupId: string | null } }>>(ungroupedSecondLayer)).data.layer
        .groupId,
    ).toBeNull();

    const layersList = await adminGet('/api/v1/admin/layers');
    const layersListEtag = requiredHeader(layersList, 'etag');
    const reorderLayerKey = randomUUID();
    const reorderedLayers = await mutate(
      editor,
      '/api/v1/admin/layers:reorder',
      {
        items: [
          { id: firstLayer.layer.id, displayOrder: 92 },
          { id: secondLayer.layer.id, displayOrder: 91 },
        ],
      },
      { ifMatch: layersListEtag, idempotencyKey: reorderLayerKey },
    );
    expect(reorderedLayers.status).toBe(200);
    await expectProblem(
      mutate(
        editor,
        '/api/v1/admin/layers:reorder',
        { items: [{ id: firstLayer.layer.id, displayOrder: 93 }] },
        { ifMatch: layersListEtag, idempotencyKey: reorderLayerKey },
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await expectProblem(
      mutate(
        editor,
        '/api/v1/admin/layers:reorder',
        { items: [{ id: firstLayer.layer.id, displayOrder: 1 }] },
        { ifMatch: layersListEtag, idempotencyKey: randomUUID() },
      ),
      412,
      'ETAG_MISMATCH',
    );

    await archiveLayer(firstLayer.layer.id);
    await archiveLayer(secondLayer.layer.id);
    const archivedSecondLayer = await adminGet(`/api/v1/admin/layers/${secondLayer.layer.id}`);
    const unarchivedSecondLayer = await mutate(
      editor,
      `/api/v1/admin/layers/${secondLayer.layer.id}:unarchive`,
      {},
      {
        ifMatch: requiredHeader(archivedSecondLayer, 'etag'),
        idempotencyKey: randomUUID(),
      },
    );
    expect(unarchivedSecondLayer.status).toBe(200);

    const catalogAudits = (await AppDataSource.query(
      `SELECT action,resource_id,before_digest,after_digest,metadata
       FROM audit_logs
       WHERE actor_id=$1 AND occurred_at >= $2
         AND action=ANY($3::text[])`,
      [
        editor.id,
        startedAt,
        [
          'layer_group.updated',
          'layer_group.reordered',
          'layer_group.archived',
          'layer.reordered',
          'layer.archived',
          'layer.unarchived',
        ],
      ],
    )) as Array<{
      action: string;
      resource_id: string | null;
      before_digest: string | null;
      after_digest: string | null;
      metadata: Record<string, unknown>;
    }>;
    for (const action of [
      'layer_group.updated',
      'layer_group.reordered',
      'layer_group.archived',
      'layer.reordered',
      'layer.archived',
      'layer.unarchived',
    ]) {
      const matching = catalogAudits.filter((row) => row.action === action);
      expect(matching.length).toBeGreaterThan(0);
      expect(matching.every((row) => row.before_digest && row.after_digest)).toBe(true);
    }
    const groupArchiveAudit = catalogAudits.find(
      (row) => row.action === 'layer_group.archived' && row.resource_id === firstGroup.data.id,
    );
    expect(groupArchiveAudit?.metadata).toMatchObject({
      orphanLayerPolicy: 'ungroup',
      ungroupedLayerCount: 2,
    });
    expect(typeof groupArchiveAudit?.metadata.ungroupedLayerIdsDigest).toBe('string');
    expect(groupArchiveAudit?.metadata).not.toHaveProperty('ungroupedLayerIds');
  });

  it('serializes group archive against layer create, move and unarchive', async () => {
    const suffix = randomUUID().slice(0, 8);

    const createRaceGroup = await createGroup(`race-create-${suffix}`, 'Nhóm race create', 201);
    const [archivedCreateGroup, competingCreate] = await Promise.all([
      mutate(
        editor,
        `/api/v1/admin/layer-groups/${createRaceGroup.data.id}:archive`,
        { orphanLayerPolicy: 'ungroup' },
        { ifMatch: createRaceGroup.etag, idempotencyKey: randomUUID() },
      ),
      mutate(
        editor,
        '/api/v1/admin/layers',
        layerPayload(`race-create-${suffix}`, createRaceGroup.data.id, 'Layer race create', 202),
        { idempotencyKey: randomUUID() },
      ),
    ]);
    expect(archivedCreateGroup.status).toBe(200);
    expect([201, 404]).toContain(competingCreate.status);
    if (competingCreate.status === 201) {
      const created = await createdLayerData(competingCreate);
      const detail = await adminGet(`/api/v1/admin/layers/${created.layer.id}`);
      expect(await layerGroupId(detail)).toBeNull();
    } else {
      await expectProblem(Promise.resolve(competingCreate), 404, 'NOT_FOUND');
    }

    const sourceGroup = await createGroup(`race-source-${suffix}`, 'Nhóm nguồn', 203);
    const moveTarget = await createGroup(`race-move-${suffix}`, 'Nhóm race move', 204);
    const movingLayer = await createLayer(
      `race-move-${suffix}`,
      sourceGroup.data.id,
      'Layer race move',
      205,
    );
    const movingLayerDetail = await adminGet(`/api/v1/admin/layers/${movingLayer.layer.id}`);
    const [archivedMoveTarget, competingMove] = await Promise.all([
      mutate(
        editor,
        `/api/v1/admin/layer-groups/${moveTarget.data.id}:archive`,
        { orphanLayerPolicy: 'ungroup' },
        { ifMatch: moveTarget.etag, idempotencyKey: randomUUID() },
      ),
      mutate(
        editor,
        `/api/v1/admin/layers/${movingLayer.layer.id}`,
        { groupId: moveTarget.data.id },
        {
          method: 'PATCH',
          ifMatch: requiredHeader(movingLayerDetail, 'etag'),
          idempotencyKey: randomUUID(),
        },
      ),
    ]);
    expect(archivedMoveTarget.status).toBe(200);
    expect([200, 404]).toContain(competingMove.status);
    if (competingMove.status === 404) {
      await expectProblem(Promise.resolve(competingMove), 404, 'NOT_FOUND');
    }
    const finalMovingLayer = await adminGet(`/api/v1/admin/layers/${movingLayer.layer.id}`);
    expect([null, sourceGroup.data.id]).toContain(await layerGroupId(finalMovingLayer));

    const unarchiveGroup = await createGroup(
      `race-unarchive-${suffix}`,
      'Nhóm race unarchive',
      206,
    );
    const archivedLayer = await createLayer(
      `race-unarchive-${suffix}`,
      unarchiveGroup.data.id,
      'Layer race unarchive',
      207,
    );
    const activeLayerDetail = await adminGet(`/api/v1/admin/layers/${archivedLayer.layer.id}`);
    const archivedLayerResponse = await mutate(
      editor,
      `/api/v1/admin/layers/${archivedLayer.layer.id}:archive`,
      {},
      {
        ifMatch: requiredHeader(activeLayerDetail, 'etag'),
        idempotencyKey: randomUUID(),
      },
    );
    expect(archivedLayerResponse.status).toBe(200);
    const [archivedUnarchiveGroup, competingUnarchive] = await Promise.all([
      mutate(
        editor,
        `/api/v1/admin/layer-groups/${unarchiveGroup.data.id}:archive`,
        { orphanLayerPolicy: 'ungroup' },
        { ifMatch: unarchiveGroup.etag, idempotencyKey: randomUUID() },
      ),
      mutate(
        editor,
        `/api/v1/admin/layers/${archivedLayer.layer.id}:unarchive`,
        {},
        {
          ifMatch: requiredHeader(archivedLayerResponse, 'etag'),
          idempotencyKey: randomUUID(),
        },
      ),
    ]);
    expect(archivedUnarchiveGroup.status).toBe(200);
    expect([200, 404]).toContain(competingUnarchive.status);
    if (competingUnarchive.status === 404) {
      await expectProblem(Promise.resolve(competingUnarchive), 404, 'NOT_FOUND');
    }
    const finalUnarchivedLayer = await adminGet(`/api/v1/admin/layers/${archivedLayer.layer.id}`);
    expect(await layerGroupId(finalUnarchivedLayer)).toBeNull();

    const invalidReferences = (await AppDataSource.query(
      `SELECT count(*)::integer AS count
       FROM layers layer JOIN layer_groups layer_group ON layer_group.id=layer.group_id
       WHERE layer_group.archived_at IS NOT NULL`,
    )) as Array<{ count: number }>;
    expect(invalidReferences[0]!.count).toBe(0);
  });

  it('enforces roles, CSRF and If-Match across lifecycle configuration mutations', async () => {
    const suffix = randomUUID().slice(0, 8);
    const group = await createGroup(`guards-${suffix}`, 'Nhóm guards', 208);
    const layer = await createLayer(`guards-${suffix}`, group.data.id, 'Layer guards', 209);
    const groupListEtag = requiredHeader(await adminGet('/api/v1/admin/layer-groups'), 'etag');
    const layerListEtag = requiredHeader(await adminGet('/api/v1/admin/layers'), 'etag');
    const layerDetailEtag = requiredHeader(
      await adminGet(`/api/v1/admin/layers/${layer.layer.id}`),
      'etag',
    );
    const cases: Array<{
      name: string;
      path: string;
      body: Record<string, unknown> | undefined;
      options: { method?: 'POST' | 'PATCH' | 'PUT'; ifMatch: string; idempotent?: boolean };
    }> = [
      {
        name: 'update group',
        path: `/api/v1/admin/layer-groups/${group.data.id}`,
        body: { title: 'Guarded group' },
        options: { method: 'PATCH', ifMatch: group.etag, idempotent: true },
      },
      {
        name: 'reorder groups',
        path: '/api/v1/admin/layer-groups:reorder',
        body: { items: [{ id: group.data.id, displayOrder: 210 }] },
        options: { ifMatch: groupListEtag, idempotent: true },
      },
      {
        name: 'archive group',
        path: `/api/v1/admin/layer-groups/${group.data.id}:archive`,
        body: { orphanLayerPolicy: 'ungroup' },
        options: { ifMatch: group.etag, idempotent: true },
      },
      {
        name: 'update layer',
        path: `/api/v1/admin/layers/${layer.layer.id}`,
        body: { defaultVisible: false },
        options: { method: 'PATCH', ifMatch: layerDetailEtag, idempotent: true },
      },
      {
        name: 'reorder layers',
        path: '/api/v1/admin/layers:reorder',
        body: { items: [{ id: layer.layer.id, displayOrder: 211 }] },
        options: { ifMatch: layerListEtag, idempotent: true },
      },
      {
        name: 'archive layer',
        path: `/api/v1/admin/layers/${layer.layer.id}:archive`,
        body: {},
        options: { ifMatch: layerDetailEtag, idempotent: true },
      },
      {
        name: 'unarchive layer',
        path: `/api/v1/admin/layers/${layer.layer.id}:unarchive`,
        body: {},
        options: { ifMatch: layerDetailEtag, idempotent: true },
      },
      {
        name: 'create successor',
        path: `/api/v1/admin/layers/${layer.layer.id}/drafts`,
        body: undefined,
        options: { ifMatch: layer.revisionEtag, idempotent: true },
      },
      {
        name: 'preview config impact',
        path: `/api/v1/admin/revisions/${layer.draftRevision.id}/config:impact`,
        body: configurationPayload('Guarded impact'),
        options: { ifMatch: layer.revisionEtag },
      },
      {
        name: 'replace config',
        path: `/api/v1/admin/revisions/${layer.draftRevision.id}/config`,
        body: configurationPayload('Guarded replacement'),
        options: { method: 'PUT', ifMatch: layer.revisionEtag, idempotent: true },
      },
    ];

    for (const actor of [reviewer, publisher, systemAdmin]) {
      for (const testCase of cases) {
        await expectProblem(
          mutate(actor, testCase.path, testCase.body, {
            method: testCase.options.method,
            ifMatch: testCase.options.ifMatch,
            ...(testCase.options.idempotent ? { idempotencyKey: randomUUID() } : {}),
          }),
          403,
          'ROLE_FORBIDDEN',
        );
      }
    }

    for (const testCase of cases) {
      await expectProblem(
        mutateWithoutCsrf(editor, testCase.path, testCase.body, {
          method: testCase.options.method,
          ifMatch: testCase.options.ifMatch,
          ...(testCase.options.idempotent ? { idempotencyKey: randomUUID() } : {}),
        }),
        403,
        'CSRF_INVALID',
      );
      await expectProblem(
        mutate(editor, testCase.path, testCase.body, {
          method: testCase.options.method,
          ...(testCase.options.idempotent ? { idempotencyKey: randomUUID() } : {}),
        }),
        428,
        'ETAG_REQUIRED',
      );
    }
  });

  it('previews/replaces draft config, protects data, publishes, and creates one successor', async () => {
    const suffix = randomUUID().slice(0, 8);
    const group = await createGroup(`config-${suffix}`, 'Nhóm cấu hình', 110);
    const created = await createLayer(`config-${suffix}`, group.data.id, 'Đối tượng cấu hình', 120);
    const revisionId = created.draftRevision.id;
    const safeConfig = configurationPayload('Đối tượng cấu hình đã cập nhật');

    for (const actor of [reviewer, publisher, systemAdmin]) {
      await expectProblem(
        mutate(actor, `/api/v1/admin/revisions/${revisionId}/config`, safeConfig, {
          method: 'PUT',
          ifMatch: created.revisionEtag,
          idempotencyKey: randomUUID(),
        }),
        403,
        'ROLE_FORBIDDEN',
      );
    }

    const impact = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/config:impact`,
      safeConfig,
      { ifMatch: created.revisionEtag },
    );
    expect(impact.status).toBe(200);
    expect((await json<Envelope<Record<string, unknown>>>(impact)).data).toMatchObject({
      featureCount: 0,
      blocking: false,
      schemaVersionWillIncrement: true,
      reasons: [],
    });

    const layerListBeforeRevisionMutation = requiredHeader(
      await adminGet('/api/v1/admin/layers'),
      'etag',
    );

    const replaceKey = randomUUID();
    const replaced = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/config`,
      safeConfig,
      { method: 'PUT', ifMatch: created.revisionEtag, idempotencyKey: replaceKey },
    );
    expect(replaced.status).toBe(200);
    const replacedData = (
      await json<
        Envelope<{
          revision: { id: string; title: string; schemaVersion: number; lockVersion: number };
          fields: Array<Record<string, unknown>>;
        }>
      >(replaced)
    ).data;
    const replacedEtag = requiredHeader(replaced, 'etag');
    expect(requiredHeader(await adminGet('/api/v1/admin/layers'), 'etag')).not.toBe(
      layerListBeforeRevisionMutation,
    );
    expect(replacedData.revision).toMatchObject({
      id: revisionId,
      title: 'Đối tượng cấu hình đã cập nhật',
      schemaVersion: 2,
      lockVersion: 2,
    });
    expect(replacedData.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'name', label: 'Tên hiển thị', searchable: true }),
        expect.objectContaining({ key: 'category', filterable: true }),
      ]),
    );
    const replaceReplay = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/config`,
      safeConfig,
      { method: 'PUT', ifMatch: created.revisionEtag, idempotencyKey: replaceKey },
    );
    expect(requiredHeader(replaceReplay, 'etag')).toBe(replacedEtag);
    await expectProblem(
      mutate(
        editor,
        `/api/v1/admin/revisions/${revisionId}/config`,
        configurationPayload('Payload config khác cho cùng key'),
        { method: 'PUT', ifMatch: created.revisionEtag, idempotencyKey: replaceKey },
      ),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await expectProblem(
      mutate(editor, `/api/v1/admin/revisions/${revisionId}/config`, safeConfig, {
        method: 'PUT',
        ifMatch: created.revisionEtag,
        idempotencyKey: randomUUID(),
      }),
      412,
      'ETAG_MISMATCH',
    );

    const createFeature = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/features`,
      {
        geometry: { type: 'Point', coordinates: [108.2208, 16.0678] },
        geometryKind: 'point',
        properties: { name: 'Trung tâm hành chính', category: 'public-service' },
      },
      { ifMatch: replacedEtag, idempotencyKey: randomUUID() },
    );
    expect(createFeature.status).toBe(201);
    const featureEtag = requiredHeader(createFeature, 'etag');
    await AppDataSource.query(
      `WITH new_features AS (
         INSERT INTO features(layer_id)
         SELECT $1 FROM generate_series(1,250)
         RETURNING id
       ), new_versions AS (
         INSERT INTO feature_versions(
           feature_id,revision_id,geometry,geometry_kind,properties,checksum,created_by
         )
         SELECT id,$2,ST_SetSRID(ST_MakePoint(108.2208,16.0678),4326),'point',
           jsonb_build_object(
             'name','Trung tâm hành chính ' || id::text,
             'category','public-service'
           ),md5(id::text),$3
         FROM new_features
         RETURNING id,feature_id
       )
       INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
       SELECT $2,feature_id,id,row_number() OVER (ORDER BY feature_id)::integer
       FROM new_versions`,
      [created.layer.id, revisionId, editor.id],
    );

    const harmlessConstraintChange = configurationPayload('Ràng buộc nới lỏng');
    const harmlessFields = harmlessConstraintChange.fields as Array<Record<string, unknown>>;
    harmlessFields[0]!.validation = { minLength: 1, maxLength: 240 };
    harmlessFields[1]!.options = ['community', 'public-service', 'health'];
    const harmlessImpact = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/config:impact`,
      harmlessConstraintChange,
      { ifMatch: featureEtag },
    );
    expect(harmlessImpact.status).toBe(200);
    expect((await json<Envelope<Record<string, unknown>>>(harmlessImpact)).data).toMatchObject({
      featureCount: 251,
      blocking: false,
      reasons: [],
    });

    const tighteningConstraintChange = configurationPayload('Ràng buộc siết chặt');
    const tighteningFields = tighteningConstraintChange.fields as Array<Record<string, unknown>>;
    tighteningFields[0]!.validation = { minLength: 2, maxLength: 5 };
    tighteningFields[1]!.options = ['community'];
    const tighteningImpact = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/config:impact`,
      tighteningConstraintChange,
      { ifMatch: featureEtag },
    );
    expect(tighteningImpact.status).toBe(200);
    expect(
      (await json<Envelope<{ reasons: Array<Record<string, unknown>> }>>(tighteningImpact)).data
        .reasons,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FIELD_CONSTRAINT_CHANGE_WITH_DATA',
          fieldKey: 'name',
          affectedFeatures: 251,
        }),
        expect.objectContaining({
          code: 'FIELD_CONSTRAINT_CHANGE_WITH_DATA',
          fieldKey: 'category',
          affectedFeatures: 251,
        }),
      ]),
    );

    const incompatible = incompatibleConfigurationPayload();
    const blockedImpact = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/config:impact`,
      incompatible,
      { ifMatch: featureEtag },
    );
    expect(blockedImpact.status).toBe(200);
    const blocked = (
      await json<Envelope<{ blocking: boolean; reasons: Array<{ code: string }> }>>(blockedImpact)
    ).data;
    expect(blocked.blocking).toBe(true);
    expect(blocked.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'GEOMETRY_KIND_IN_USE',
        'FIELD_REMOVAL_WITH_DATA',
        'REQUIRED_FIELD_MISSING',
      ]),
    );
    const blockedReplace = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/config`,
      incompatible,
      { method: 'PUT', ifMatch: featureEtag, idempotencyKey: randomUUID() },
    );
    await expectProblem(Promise.resolve(blockedReplace), 422, 'CONFIG_IMPACT_BLOCKED');

    await expectStatus(
      mutate(
        editor,
        `/api/v1/admin/revisions/${revisionId}:submit`,
        { summary: 'Gửi duyệt lifecycle' },
        { idempotencyKey: randomUUID() },
      ),
      202,
    );
    await expectStatus(
      mutate(
        reviewer,
        `/api/v1/admin/revisions/${revisionId}:approve`,
        { comment: 'Đồng ý' },
        { idempotencyKey: randomUUID() },
      ),
      201,
    );
    const initialPublish = await mutate(
      publisher,
      `/api/v1/admin/revisions/${revisionId}:publish`,
      { releaseNote: 'Công bố lifecycle' },
      { idempotencyKey: randomUUID() },
    );
    expect(initialPublish.status).toBe(202);
    const initialSnapshotId = (await json<Envelope<{ snapshotId: string }>>(initialPublish)).data
      .snapshotId;

    const publishedRevision = await adminGet(`/api/v1/admin/revisions/${revisionId}`);
    const publishedEtag = requiredHeader(publishedRevision, 'etag');
    await expectProblem(
      mutate(editor, `/api/v1/admin/revisions/${revisionId}/config`, safeConfig, {
        method: 'PUT',
        ifMatch: publishedEtag,
        idempotencyKey: randomUUID(),
      }),
      409,
      'REVISION_NOT_EDITABLE',
    );

    const publicLayer = await fetch(`${apiBaseUrl}/api/v1/public/layers/${created.layer.slug}`);
    expect(publicLayer.status).toBe(200);
    expect(
      (
        await json<
          Envelope<{
            title: string;
            displayOrder: number;
            defaultVisible: boolean;
            style: Record<string, unknown>;
            filterCapabilities: { fieldKeys: string[] };
            searchCapabilities: { fieldKeys: string[] };
          }>
        >(publicLayer)
      ).data,
    ).toMatchObject({
      title: 'Đối tượng cấu hình đã cập nhật',
      displayOrder: 120,
      defaultVisible: true,
      style: { point: { color: '#2F80ED', radius: 9 } },
      filterCapabilities: { fieldKeys: ['category'] },
      searchCapabilities: { fieldKeys: ['name'] },
    });

    for (const actor of [reviewer, publisher, systemAdmin]) {
      await expectProblem(
        mutate(actor, `/api/v1/admin/layers/${created.layer.id}/drafts`, undefined, {
          ifMatch: publishedEtag,
          idempotencyKey: randomUUID(),
        }),
        403,
        'ROLE_FORBIDDEN',
      );
    }
    const successorKey = randomUUID();
    const competingSuccessorKey = randomUUID();
    const concurrentSuccessors = await Promise.all([
      mutate(editor, `/api/v1/admin/layers/${created.layer.id}/drafts`, undefined, {
        ifMatch: publishedEtag,
        idempotencyKey: successorKey,
      }),
      mutate(editor, `/api/v1/admin/layers/${created.layer.id}/drafts`, undefined, {
        ifMatch: publishedEtag,
        idempotencyKey: competingSuccessorKey,
      }),
    ]);
    expect(concurrentSuccessors.map((response) => response.status).sort()).toEqual([201, 409]);
    const successor = concurrentSuccessors.find((response) => response.status === 201)!;
    const rejectedSuccessor = concurrentSuccessors.find((response) => response.status === 409)!;
    await expectProblem(Promise.resolve(rejectedSuccessor), 409, 'DRAFT_ALREADY_EXISTS');
    const winningSuccessorKey =
      concurrentSuccessors[0] === successor ? successorKey : competingSuccessorKey;
    const successorData = (
      await json<
        Envelope<{
          sourceRevisionId: string;
          draftRevision: { id: string; supersedesRevisionId: string; status: string };
          draftEtag: string;
          featureCount: number;
        }>
      >(successor)
    ).data;
    revisionIds.push(successorData.draftRevision.id);
    expect(successorData).toMatchObject({
      sourceRevisionId: revisionId,
      featureCount: 251,
      draftRevision: {
        status: 'draft',
        supersedesRevisionId: revisionId,
      },
    });
    expect(requiredHeader(successor, 'etag')).toBe(successorData.draftEtag);
    const successorReplay = await mutate(
      editor,
      `/api/v1/admin/layers/${created.layer.id}/drafts`,
      undefined,
      { ifMatch: publishedEtag, idempotencyKey: winningSuccessorKey },
    );
    expect(
      (await json<Envelope<{ draftRevision: { id: string } }>>(successorReplay)).data.draftRevision
        .id,
    ).toBe(successorData.draftRevision.id);
    await expectProblem(
      mutate(editor, `/api/v1/admin/layers/${created.layer.id}/drafts`, undefined, {
        ifMatch: successorData.draftEtag,
        idempotencyKey: winningSuccessorKey,
      }),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await expectProblem(
      mutate(editor, `/api/v1/admin/layers/${created.layer.id}/drafts`, undefined, {
        ifMatch: publishedEtag,
        idempotencyKey: randomUUID(),
      }),
      409,
      'DRAFT_ALREADY_EXISTS',
    );
    const successorRevision = await adminGet(
      `/api/v1/admin/revisions/${successorData.draftRevision.id}`,
    );
    const successorReloaded = (
      await json<Envelope<{ revision: { supersedesRevisionId: string }; fields: unknown[] }>>(
        successorRevision,
      )
    ).data;
    expect(successorReloaded.revision.supersedesRevisionId).toBe(revisionId);
    expect(successorReloaded.fields).toHaveLength(2);
    const successorWorkspace = await adminGet(
      `/api/v1/admin/revisions/${successorData.draftRevision.id}/workspace`,
    );
    expect(
      (await json<Envelope<{ featureCount: number }>>(successorWorkspace)).data.featureCount,
    ).toBe(251);

    await expectStatus(
      mutate(
        editor,
        `/api/v1/admin/revisions/${successorData.draftRevision.id}:submit`,
        { summary: 'Gửi successor duyệt' },
        { idempotencyKey: randomUUID() },
      ),
      202,
    );
    await expectProblem(
      mutate(editor, `/api/v1/admin/layers/${created.layer.id}/drafts`, undefined, {
        ifMatch: publishedEtag,
        idempotencyKey: randomUUID(),
      }),
      409,
      'DRAFT_ALREADY_EXISTS',
    );

    const requestChangesKey = randomUUID();
    const crossPathCreateKey = randomUUID();
    const [requestedChanges, rejectedCrossPathCreate] = await Promise.all([
      mutate(
        reviewer,
        `/api/v1/admin/revisions/${successorData.draftRevision.id}:request-changes`,
        { comment: 'Cần bổ sung metadata' },
        { idempotencyKey: requestChangesKey },
      ),
      mutate(editor, `/api/v1/admin/layers/${created.layer.id}/drafts`, undefined, {
        ifMatch: publishedEtag,
        idempotencyKey: crossPathCreateKey,
      }),
    ]);
    expect(requestedChanges.status).toBe(201);
    await expectProblem(Promise.resolve(rejectedCrossPathCreate), 409, 'DRAFT_ALREADY_EXISTS');
    const requestedChangesData = (
      await json<Envelope<{ draftRevisionId: string; draftEtag: string }>>(requestedChanges)
    ).data;
    revisionIds.push(requestedChangesData.draftRevisionId);
    const activeDraftRows = (await AppDataSource.query(
      `SELECT id FROM layer_revisions WHERE layer_id=$1 AND status='draft'`,
      [created.layer.id],
    )) as Array<{ id: string }>;
    expect(activeDraftRows).toEqual([{ id: requestedChangesData.draftRevisionId }]);
    const requestedDraft = await adminGet(
      `/api/v1/admin/revisions/${requestedChangesData.draftRevisionId}`,
    );
    expect(
      (
        await json<Envelope<{ revision: { supersedesRevisionId: string }; fields: unknown[] }>>(
          requestedDraft,
        )
      ).data,
    ).toMatchObject({
      revision: { supersedesRevisionId: successorData.draftRevision.id },
    });
    expect(
      (
        await json<Envelope<{ fields: unknown[] }>>(
          await adminGet(`/api/v1/admin/revisions/${requestedChangesData.draftRevisionId}`),
        )
      ).data.fields,
    ).toHaveLength(2);
    expect(
      (
        await json<Envelope<{ featureCount: number }>>(
          await adminGet(
            `/api/v1/admin/revisions/${requestedChangesData.draftRevisionId}/workspace`,
          ),
        )
      ).data.featureCount,
    ).toBe(251);

    await expectStatus(
      mutate(
        editor,
        `/api/v1/admin/revisions/${requestedChangesData.draftRevisionId}:submit`,
        { summary: 'Gửi successor sau request changes' },
        { idempotencyKey: randomUUID() },
      ),
      202,
    );
    await expectStatus(
      mutate(
        reviewer,
        `/api/v1/admin/revisions/${requestedChangesData.draftRevisionId}:approve`,
        { comment: 'Đồng ý successor' },
        { idempotencyKey: randomUUID() },
      ),
      201,
    );
    await expectProblem(
      mutate(editor, `/api/v1/admin/layers/${created.layer.id}/drafts`, undefined, {
        ifMatch: publishedEtag,
        idempotencyKey: randomUUID(),
      }),
      409,
      'DRAFT_ALREADY_EXISTS',
    );
    await expectStatus(
      mutate(
        publisher,
        `/api/v1/admin/revisions/${requestedChangesData.draftRevisionId}:publish`,
        { releaseNote: 'Công bố successor đã duyệt' },
        { idempotencyKey: randomUUID() },
      ),
      202,
    );

    const currentPublishedRevision = await adminGet(
      `/api/v1/admin/revisions/${requestedChangesData.draftRevisionId}`,
    );
    const staleCandidateResponse = await mutate(
      editor,
      `/api/v1/admin/layers/${created.layer.id}/drafts`,
      undefined,
      {
        ifMatch: requiredHeader(currentPublishedRevision, 'etag'),
        idempotencyKey: randomUUID(),
      },
    );
    expect(staleCandidateResponse.status).toBe(201);
    const staleCandidate = (
      await json<Envelope<{ draftRevision: { id: string } }>>(staleCandidateResponse)
    ).data.draftRevision;
    revisionIds.push(staleCandidate.id);
    await expectStatus(
      mutate(
        editor,
        `/api/v1/admin/revisions/${staleCandidate.id}:submit`,
        { summary: 'Ứng viên stale base' },
        { idempotencyKey: randomUUID() },
      ),
      202,
    );
    await expectStatus(
      mutate(
        reviewer,
        `/api/v1/admin/revisions/${staleCandidate.id}:approve`,
        { comment: 'Duyệt trước rollback' },
        { idempotencyKey: randomUUID() },
      ),
      201,
    );
    const rollback = await mutate(
      publisher,
      `/api/v1/admin/layers/${created.layer.id}:rollback`,
      { targetSnapshotId: initialSnapshotId, reason: 'Kiểm tra stale publication base' },
      { idempotencyKey: randomUUID() },
    );
    expect(rollback.status).toBe(201);
    const rollbackSnapshotId = (await json<Envelope<{ snapshotId: string }>>(rollback)).data
      .snapshotId;
    await expectProblem(
      mutate(
        publisher,
        `/api/v1/admin/revisions/${staleCandidate.id}:publish`,
        { releaseNote: 'Không được công bố stale base' },
        { idempotencyKey: randomUUID() },
      ),
      409,
      'PUBLICATION_BASE_STALE',
    );
    expect(
      (
        await json<Envelope<{ revision: { status: string } }>>(
          await adminGet(`/api/v1/admin/revisions/${staleCandidate.id}`),
        )
      ).data.revision.status,
    ).toBe('approved');
    const activePublication = (await AppDataSource.query(
      `SELECT active_snapshot_id FROM layer_publications WHERE layer_id=$1`,
      [created.layer.id],
    )) as Array<{ active_snapshot_id: string }>;
    expect(activePublication[0]!.active_snapshot_id).toBe(rollbackSnapshotId);

    const layerDetail = await adminGet(`/api/v1/admin/layers/${created.layer.id}`);
    const archived = await mutate(
      editor,
      `/api/v1/admin/layers/${created.layer.id}:archive`,
      {},
      {
        ifMatch: requiredHeader(layerDetail, 'etag'),
        idempotencyKey: randomUUID(),
      },
    );
    expect(archived.status).toBe(200);
    await expectProblem(
      fetch(`${apiBaseUrl}/api/v1/public/layers/${created.layer.slug}`),
      404,
      'LAYER_NOT_FOUND',
    );
    const unarchived = await mutate(
      editor,
      `/api/v1/admin/layers/${created.layer.id}:unarchive`,
      {},
      { ifMatch: requiredHeader(archived, 'etag'), idempotencyKey: randomUUID() },
    );
    expect(unarchived.status).toBe(200);
    expect((await fetch(`${apiBaseUrl}/api/v1/public/layers/${created.layer.slug}`)).status).toBe(
      200,
    );

    const auditCounts = (await AppDataSource.query(
      `SELECT action,count(*)::integer AS count
       FROM audit_logs WHERE actor_id=$1 AND occurred_at >= $2
         AND action='revision.config_updated' AND resource_id=$3
       GROUP BY action`,
      [editor.id, startedAt, revisionId],
    )) as Array<{ action: string; count: number }>;
    expect(Object.fromEntries(auditCounts.map((row) => [row.action, row.count]))).toMatchObject({
      'revision.config_updated': 1,
    });
    const initialSuccessorAudit = (await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM audit_logs
       WHERE action='revision.successor_created' AND resource_id=$1`,
      [successorData.draftRevision.id],
    )) as Array<{ count: number }>;
    expect(initialSuccessorAudit[0]!.count).toBe(1);
  });

  it('declares ETag response headers for every versioned layer lifecycle operation', async () => {
    const response = await fetch(`${apiBaseUrl}/api/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            responses?: Record<string, { headers?: Record<string, unknown> }>;
          }
        >
      >;
    };
    const expected = new Map<string, string>([
      ['listLayerGroups', '200'],
      ['createLayerGroup', '201'],
      ['getLayerGroup', '200'],
      ['updateLayerGroup', '200'],
      ['reorderLayerGroups', '200'],
      ['archiveLayerGroup', '200'],
      ['listAdminLayers', '200'],
      ['createLayer', '201'],
      ['getAdminLayer', '200'],
      ['updateLayerCatalogConfig', '200'],
      ['reorderLayers', '200'],
      ['archiveLayer', '200'],
      ['unarchiveLayer', '200'],
      ['createSuccessorDraft', '201'],
      ['getRevision', '200'],
      ['previewRevisionConfigurationImpact', '200'],
      ['replaceDraftRevisionConfiguration', '200'],
      ['getRevisionWorkspace', '200'],
      ['createFeature', '201'],
      ['updateFeature', '200'],
      ['deleteFeature', '200'],
    ]);
    const operations = Object.values(document.paths).flatMap((path) => Object.values(path));
    for (const [operationId, status] of expected) {
      const operation = operations.find((candidate) => candidate.operationId === operationId);
      expect(operation).toBeDefined();
      expect(operation?.responses?.[status]?.headers).toHaveProperty('ETag');
    }
  });

  async function createGroup(slug: string, title: string, displayOrder: number) {
    const response = await mutate(
      editor,
      '/api/v1/admin/layer-groups',
      { slug, title, displayOrder, defaultVisible: true },
      { idempotencyKey: randomUUID() },
    );
    expect(response.status).toBe(201);
    const data = (await json<Envelope<{ id: string; slug: string }>>(response)).data;
    groupIds.push(data.id);
    return { data, etag: requiredHeader(response, 'etag') };
  }

  async function createLayer(slug: string, groupId: string, title: string, displayOrder: number) {
    const response = await mutate(
      editor,
      '/api/v1/admin/layers',
      layerPayload(slug, groupId, title, displayOrder),
      { idempotencyKey: randomUUID() },
    );
    expect(response.status).toBe(201);
    const data = await createdLayerData(response);
    return { ...data, revisionEtag: requiredHeader(response, 'etag') };
  }

  async function createdLayerData(response: Response) {
    const data = (
      await json<
        Envelope<{
          layer: { id: string; slug: string };
          draftRevision: { id: string };
        }>
      >(response)
    ).data;
    layerIds.push(data.layer.id);
    revisionIds.push(data.draftRevision.id);
    return data;
  }

  async function layerGroupId(response: Response): Promise<string | null> {
    expect(response.status).toBe(200);
    return (await json<Envelope<{ layer: { groupId: string | null } }>>(response)).data.layer
      .groupId;
  }

  async function archiveLayer(layerId: string): Promise<void> {
    const detail = await adminGet(`/api/v1/admin/layers/${layerId}`);
    const response = await mutate(
      editor,
      `/api/v1/admin/layers/${layerId}:archive`,
      {},
      {
        ifMatch: requiredHeader(detail, 'etag'),
        idempotencyKey: randomUUID(),
      },
    );
    expect(response.status).toBe(200);
  }

  function adminGet(path: string): Promise<Response> {
    return fetch(`${apiBaseUrl}${path}`, { headers: { Cookie: editor.cookie } });
  }
});

function layerPayload(
  slug: string,
  groupId: string,
  title: string,
  displayOrder: number,
): Record<string, unknown> {
  return {
    slug,
    groupId,
    displayOrder,
    defaultVisible: true,
    title,
    geometryMode: 'mixed',
    allowedGeometryKinds: ['point', 'polygon'],
    fields: [
      {
        key: 'name',
        label: 'Tên',
        type: 'text',
        required: true,
        public: true,
        searchable: true,
        validation: { minLength: 2, maxLength: 120 },
      },
      {
        key: 'category',
        label: 'Phân loại',
        type: 'enum',
        public: true,
        filterable: true,
        options: ['public-service', 'community'],
      },
    ],
    style: {
      point: { color: '#1A73E8', radius: 8 },
      polygon: { fillColor: '#EAF3FF', strokeColor: '#1A73E8' },
    },
    renderConfig: { minZoom: 7, maxZoom: 19, sourcePolicy: 'geojson' },
    popupConfig: { titleField: 'name', fieldKeys: ['name', 'category'] },
  };
}

function configurationPayload(title: string): Record<string, unknown> {
  return {
    title,
    description: 'Cấu hình thay thế toàn phần.',
    geometryMode: 'mixed',
    allowedGeometryKinds: ['point', 'polygon'],
    fields: [
      {
        key: 'name',
        label: 'Tên hiển thị',
        type: 'text',
        required: true,
        public: true,
        searchable: true,
        validation: { minLength: 2, maxLength: 120 },
        displayOrder: 10,
      },
      {
        key: 'category',
        label: 'Phân loại',
        type: 'enum',
        public: true,
        filterable: true,
        options: ['public-service', 'community'],
        displayOrder: 20,
      },
    ],
    style: {
      point: { color: '#2F80ED', radius: 9 },
      polygon: { fillColor: '#EAF3FF', fillOpacity: 0.4, strokeColor: '#2F80ED' },
    },
    renderConfig: { minZoom: 6, maxZoom: 20, cluster: false, sourcePolicy: 'geojson' },
    popupConfig: { titleField: 'name', fieldKeys: ['name', 'category'], showCoordinates: true },
  };
}

function incompatibleConfigurationPayload(): Record<string, unknown> {
  return {
    title: 'Cấu hình không tương thích',
    geometryMode: 'polygon',
    allowedGeometryKinds: ['polygon'],
    fields: [
      {
        key: 'category',
        label: 'Phân loại',
        type: 'enum',
        public: true,
        filterable: true,
        options: ['public-service', 'community'],
      },
      {
        key: 'code',
        label: 'Mã bắt buộc',
        type: 'text',
        required: true,
        public: true,
      },
    ],
    style: { polygon: { fillColor: '#EAF3FF', strokeColor: '#2F80ED' } },
    renderConfig: { minZoom: 6, maxZoom: 20, sourcePolicy: 'geojson' },
    popupConfig: { titleField: 'category', fieldKeys: ['category', 'code'] },
  };
}

async function login(user: (typeof users)[keyof typeof users]): Promise<AuthenticatedActor> {
  const publicCsrfResponse = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`);
  expect(publicCsrfResponse.status).toBe(200);
  const publicCsrf = (await json<Envelope<{ csrfToken: string }>>(publicCsrfResponse)).data
    .csrfToken;
  const publicCsrfCookie = cookieValue(publicCsrfResponse, 'danangmap_csrf');
  const loginResponse = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `danangmap_csrf=${publicCsrfCookie}`,
      Origin: frontendOrigin,
      'X-CSRF-Token': publicCsrf,
    },
    body: JSON.stringify({ login: user.login, password: user.password }),
  });
  expect(loginResponse.status).toBe(200);
  const preauth = cookieValue(loginResponse, '__Host-danangmap_preauth');
  const preauthCsrf = cookieValue(loginResponse, 'danangmap_csrf');
  const verifyResponse = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `__Host-danangmap_preauth=${preauth}; danangmap_csrf=${preauthCsrf}`,
      Origin: frontendOrigin,
      'X-CSRF-Token': preauthCsrf,
    },
    body: JSON.stringify({ method: 'totp', code: totp(mfaSecret) }),
  });
  expect(verifyResponse.status).toBe(200);
  const session = cookieValue(verifyResponse, '__Host-danangmap_session');
  let csrf = cookieValue(verifyResponse, 'danangmap_csrf');
  const rotateResponse = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: { Cookie: `__Host-danangmap_session=${session}; danangmap_csrf=${csrf}` },
  });
  expect(rotateResponse.status).toBe(200);
  csrf = (await json<Envelope<{ csrfToken: string }>>(rotateResponse)).data.csrfToken;
  return {
    id: user.id,
    cookie: `__Host-danangmap_session=${session}; danangmap_csrf=${csrf}`,
    csrf,
  };
}

async function mutate(
  actor: AuthenticatedActor,
  path: string,
  body: Record<string, unknown> | undefined,
  options: {
    method?: 'POST' | 'PATCH' | 'PUT';
    idempotencyKey?: string;
    ifMatch?: string;
  } = {},
): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: actor.cookie,
      Origin: frontendOrigin,
      'X-CSRF-Token': actor.csrf,
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function mutateWithoutCsrf(
  actor: AuthenticatedActor,
  path: string,
  body: Record<string, unknown> | undefined,
  options: {
    method?: 'POST' | 'PATCH' | 'PUT';
    idempotencyKey?: string;
    ifMatch?: string;
  } = {},
): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: actor.cookie,
      Origin: frontendOrigin,
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function expectStatus(responsePromise: Promise<Response>, status: number): Promise<void> {
  expect((await responsePromise).status).toBe(status);
}

async function expectProblem(responsePromise: Promise<Response>, status: number, code: string) {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const problem = (await response.json()) as { status: number; code: string; requestId: string };
  expect(problem).toMatchObject({ status, code });
  expect(problem.requestId).toBeTruthy();
}

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  if (!match?.[1]) throw new Error(`Missing cookie ${name}: ${header}`);
  return match[1];
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`Missing response header ${name}`);
  return value;
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function totp(secret: string, epoch = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epoch / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.toUpperCase().replaceAll('=', '')) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid Base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}
