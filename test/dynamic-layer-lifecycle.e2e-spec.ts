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
        { items: [{ id: firstGroup.data.id, displayOrder: 1 }] },
        { ifMatch: groupsListEtag, idempotencyKey: randomUUID() },
      ),
      412,
      'ETAG_MISMATCH',
    );

    const secondLayerDetail = await adminGet(`/api/v1/admin/layers/${secondLayer.layer.id}`);
    const movedLayer = await mutate(
      editor,
      `/api/v1/admin/layers/${secondLayer.layer.id}`,
      { groupId: firstGroup.data.id, displayOrder: 85, defaultVisible: false },
      {
        method: 'PATCH',
        ifMatch: requiredHeader(secondLayerDetail, 'etag'),
        idempotencyKey: randomUUID(),
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
    const reorderedLayers = await mutate(
      editor,
      '/api/v1/admin/layers:reorder',
      {
        items: [
          { id: firstLayer.layer.id, displayOrder: 92 },
          { id: secondLayer.layer.id, displayOrder: 91 },
        ],
      },
      { ifMatch: layersListEtag, idempotencyKey: randomUUID() },
    );
    expect(reorderedLayers.status).toBe(200);
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
    await expectStatus(
      mutate(
        publisher,
        `/api/v1/admin/revisions/${revisionId}:publish`,
        { releaseNote: 'Công bố lifecycle' },
        { idempotencyKey: randomUUID() },
      ),
      202,
    );

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
      featureCount: 1,
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
    ).toBe(1);

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
         AND action=ANY($3::text[]) GROUP BY action`,
      [
        editor.id,
        startedAt,
        [
          'layer_group.updated',
          'layer_group.reordered',
          'layer_group.archived',
          'revision.config_updated',
          'revision.successor_created',
        ],
      ],
    )) as Array<{ action: string; count: number }>;
    expect(Object.fromEntries(auditCounts.map((row) => [row.action, row.count]))).toMatchObject({
      'layer_group.updated': 1,
      'layer_group.reordered': 1,
      'layer_group.archived': 1,
      'revision.config_updated': 1,
      'revision.successor_created': 1,
    });
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
      {
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
      },
      { idempotencyKey: randomUUID() },
    );
    expect(response.status).toBe(201);
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
    return { ...data, revisionEtag: requiredHeader(response, 'etag') };
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
