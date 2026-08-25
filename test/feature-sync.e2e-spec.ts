import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AppDataSource from '../src/database/data-source';
import { E2E_PREAUTH_COOKIE, E2E_SESSION_COOKIE } from './auth-cookie.helper';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
const frontendOrigin = 'http://localhost:3000';
const mfaSecret = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const execFileAsync = promisify(execFile);
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
  cookie: string;
  csrf: string;
}

interface Envelope<T> {
  data: T;
  meta: Record<string, unknown>;
}

describe('Durable feature batch sync HTTP E2E', () => {
  const startedAt = new Date();
  let systemAdmin: Actor;
  let editor: Actor;
  let reviewer: Actor;
  let publisher: Actor;
  let layerId = '';
  let revisionId = '';

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])',
      [Object.values(users).map((user) => user.id)],
    );
    systemAdmin = await login(users.systemAdmin);
    editor = await login(users.editor);
    reviewer = await login(users.reviewer);
    publisher = await login(users.publisher);
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query(
        'ALTER TABLE workflow_events DISABLE TRIGGER trg_workflow_events_immutable',
      );
      if (revisionId) {
        await manager.query('DELETE FROM client_mutations WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM revision_changes WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM workflow_events WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM revision_participants WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM revision_features WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM feature_versions WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM layer_fields WHERE revision_id=$1', [revisionId]);
      }
      if (layerId) {
        await manager.query(
          `DELETE FROM audit_logs
           WHERE id IN (SELECT audit_id FROM audit_layer_scopes WHERE layer_id=$1)`,
          [layerId],
        );
        await manager.query('DELETE FROM features WHERE layer_id=$1', [layerId]);
        await manager.query('DELETE FROM layer_revisions WHERE layer_id=$1', [layerId]);
        await manager.query('DELETE FROM layers WHERE id=$1', [layerId]);
      }
      await manager.query(
        `DELETE FROM command_receipts
         WHERE actor_id=ANY($1::uuid[]) AND created_at >= $2`,
        [Object.values(users).map((user) => user.id), startedAt],
      );
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

  it('applies ordered partial batches, replays receipts and preserves UUID mappings', async () => {
    const created = await mutate(
      editor,
      '/api/v1/admin/layers',
      layerPayload(`sync-${randomUUID().slice(0, 8)}`),
      { idempotencyKey: randomUUID() },
    );
    expect(created.status).toBe(201);
    const createdData = (
      await json<
        Envelope<{ layer: { id: string }; draftRevision: { id: string; lockVersion: number } }>
      >(created)
    ).data;
    layerId = createdData.layer.id;
    revisionId = createdData.draftRevision.id;
    const initialEtag = requiredHeader(created, 'etag');
    const workspace = await adminGet(editor, `/api/v1/admin/revisions/${revisionId}/workspace`);
    const initialCursor = (
      await json<Envelope<{ serverCursor: string; featureCount: number }>>(workspace)
    ).data.serverCursor;
    expect(initialCursor).toBe(cursor(0));

    const clientId = randomUUID();
    const mutations = geometryFixtures().map((fixture) =>
      withHash({
        clientMutationId: randomUUID(),
        operation: 'create',
        baseRevisionVersion: 1,
        clientFeatureId: randomUUID(),
        feature: fixture,
      }),
    );
    mutations.push(
      withHash({
        clientMutationId: randomUUID(),
        operation: 'create',
        baseRevisionVersion: 1,
        clientFeatureId: randomUUID(),
        feature: {
          geometry: { type: 'Point', coordinates: [108.22, 16.06] },
          geometryKind: 'point',
          properties: {},
        },
      }),
    );
    const request = { clientId, origin: 'editor', baseCursor: initialCursor, mutations };
    const response = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/changes:batch`,
      request,
      { ifMatch: initialEtag },
    );
    expect(response.status).toBe(200);
    const responseData = (
      await json<
        Envelope<{
          serverCursor: string;
          results: Array<{
            status: string;
            canonicalFeatureId?: string;
            clientFeatureId?: string;
            versionId?: string;
            error?: { code: string };
          }>;
        }>
      >(response)
    ).data;
    expect(responseData.results.map((result) => result.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
      'rejected',
    ]);
    expect(responseData.results.at(-1)?.error?.code).toBe('SCHEMA_VIOLATION');
    expect(responseData.serverCursor).toBe(cursor(7));
    for (const [index, result] of responseData.results.slice(0, 7).entries()) {
      expect(result.canonicalFeatureId).toMatch(UUID_PATTERN);
      expect(result.clientFeatureId).toBe(mutations[index]!.clientFeatureId);
      expect(result.versionId).toMatch(UUID_PATTERN);
    }
    const batchEtag = requiredHeader(response, 'etag');
    expect(etagVersion(batchEtag)).toBe(8);

    if (process.env.FEATURE_SYNC_DOCKER_RESTART === 'true') {
      await restartApiContainer();
    }

    const replay = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/changes:batch`,
      request,
      { ifMatch: initialEtag },
    );
    expect(replay.status).toBe(200);
    expect((await json<Envelope<unknown>>(replay)).data).toEqual(responseData);
    expect(requiredHeader(replay, 'etag')).toBe(batchEtag);
    const counts = (await AppDataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM client_mutations WHERE revision_id=$1) AS receipts,
         (SELECT count(*)::integer FROM revision_changes WHERE revision_id=$1) AS changes,
         (SELECT count(*)::integer FROM revision_features WHERE revision_id=$1) AS features`,
      [revisionId],
    )) as Array<{ receipts: number; changes: number; features: number }>;
    expect(counts[0]).toEqual({ receipts: 8, changes: 7, features: 7 });

    const orderedMutationIds = [randomUUID(), randomUUID()];
    const ordered = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/changes:batch`,
      {
        clientId,
        origin: 'editor',
        baseCursor: responseData.serverCursor,
        mutations: [
          withHash({
            clientMutationId: orderedMutationIds[0],
            operation: 'update',
            baseRevisionVersion: 8,
            featureId: responseData.results[0]!.canonicalFeatureId,
            baseVersionId: responseData.results[0]!.versionId,
            patch: { properties: { name: 'Đã cập nhật theo thứ tự batch' } },
          }),
          withHash({
            clientMutationId: orderedMutationIds[1],
            operation: 'delete',
            baseRevisionVersion: 8,
            featureId: responseData.results[1]!.canonicalFeatureId,
            baseVersionId: responseData.results[1]!.versionId,
          }),
        ],
      },
      { ifMatch: batchEtag },
    );
    expect(ordered.status).toBe(200);
    const orderedData = (
      await json<
        Envelope<{
          serverCursor: string;
          results: Array<{ status: string; operation: string; serverCursor: string }>;
        }>
      >(ordered)
    ).data;
    expect(orderedData.results).toMatchObject([
      { status: 'applied', operation: 'update', serverCursor: cursor(8) },
      { status: 'applied', operation: 'delete', serverCursor: cursor(9) },
    ]);
    expect(orderedData.serverCursor).toBe(cursor(9));
    const orderedEtag = requiredHeader(ordered, 'etag');
    expect(etagVersion(orderedEtag)).toBe(10);
    const orderedState = (await AppDataSource.query(
      `SELECT
         (SELECT version.properties->>'name'
          FROM revision_features link
          JOIN feature_versions version ON version.id=link.feature_version_id
          WHERE link.revision_id=$1 AND link.feature_id=$2) AS updated_name,
         EXISTS(SELECT 1 FROM revision_features WHERE revision_id=$1 AND feature_id=$3) AS deleted_exists`,
      [
        revisionId,
        responseData.results[0]!.canonicalFeatureId,
        responseData.results[1]!.canonicalFeatureId,
      ],
    )) as Array<{ updated_name: string; deleted_exists: boolean }>;
    expect(orderedState[0]).toEqual({
      updated_name: 'Đã cập nhật theo thứ tự batch',
      deleted_exists: false,
    });

    const identityless = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/changes:batch`,
      {
        clientId,
        origin: 'recovery',
        baseCursor: orderedData.serverCursor,
        mutations: [
          withHash({
            clientMutationId: randomUUID(),
            operation: 'update',
            baseRevisionVersion: 10,
            baseVersionId: responseData.results[0]!.versionId,
            patch: { properties: { name: 'Không có feature identity' } },
          }),
        ],
      },
      { ifMatch: orderedEtag },
    );
    expect(identityless.status).toBe(200);
    expect(
      (
        await json<Envelope<{ results: Array<{ status: string; error?: { code: string } }> }>>(
          identityless,
        )
      ).data.results[0],
    ).toMatchObject({ status: 'rejected', error: { code: 'SCHEMA_VIOLATION' } });
    expect(requiredHeader(identityless, 'etag')).toBe(orderedEtag);

    const changed = structuredClone(request);
    const changedFeature = changed.mutations[0]!.feature as {
      properties: Record<string, unknown>;
    };
    changedFeature.properties.name = 'Payload khác';
    changed.mutations[0] = withHash(changed.mutations[0]!);
    await expectProblem(
      mutate(editor, `/api/v1/admin/revisions/${revisionId}/changes:batch`, changed, {
        ifMatch: orderedEtag,
      }),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('allows System Admin, denies Reviewer/Publisher and never overwrites a newer version', async () => {
    const workspace = await adminGet(editor, `/api/v1/admin/revisions/${revisionId}/workspace`);
    let etag = requiredHeader(workspace, 'etag');
    let baseVersion = etagVersion(etag);
    let baseCursor = (await json<Envelope<{ serverCursor: string }>>(workspace)).data.serverCursor;
    const adminCreate = withHash({
      clientMutationId: randomUUID(),
      operation: 'create',
      baseRevisionVersion: baseVersion,
      clientFeatureId: randomUUID(),
      feature: {
        geometry: { type: 'Point', coordinates: [108.24, 16.08] },
        geometryKind: 'point',
        properties: { name: 'System Admin feature' },
      },
    });
    const adminResponse = await mutate(
      systemAdmin,
      `/api/v1/admin/revisions/${revisionId}/changes:batch`,
      {
        clientId: randomUUID(),
        origin: 'editor',
        baseCursor,
        mutations: [adminCreate],
      },
      { ifMatch: etag },
    );
    expect(adminResponse.status).toBe(200);
    etag = requiredHeader(adminResponse, 'etag');
    baseVersion = etagVersion(etag);
    baseCursor = (await json<Envelope<{ serverCursor: string }>>(adminResponse)).data.serverCursor;

    const deniedBody = {
      clientId: randomUUID(),
      origin: 'editor',
      baseCursor,
      mutations: [
        withHash({
          clientMutationId: randomUUID(),
          operation: 'create',
          baseRevisionVersion: baseVersion,
          clientFeatureId: randomUUID(),
          feature: {
            geometry: { type: 'Point', coordinates: [108.25, 16.09] },
            geometryKind: 'point',
            properties: { name: 'Không được tạo' },
          },
        }),
      ],
    };
    for (const actor of [reviewer, publisher]) {
      await expectProblem(
        mutate(actor, `/api/v1/admin/revisions/${revisionId}/changes:batch`, deniedBody, {
          ifMatch: etag,
        }),
        403,
        'ROLE_FORBIDDEN',
      );
    }

    const featureRows = (await AppDataSource.query(
      `SELECT feature_id,feature_version_id FROM revision_features
       WHERE revision_id=$1 ORDER BY ordinal,feature_id LIMIT 1`,
      [revisionId],
    )) as Array<{ feature_id: string; feature_version_id: string }>;
    const feature = featureRows[0]!;
    const clientId = randomUUID();
    const update = withHash({
      clientMutationId: randomUUID(),
      operation: 'update',
      baseRevisionVersion: baseVersion,
      featureId: feature.feature_id,
      baseVersionId: feature.feature_version_id,
      patch: { properties: { name: 'Bản mới trên máy chủ' } },
    });
    const updated = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/changes:batch`,
      { clientId, origin: 'editor', baseCursor, mutations: [update] },
      { ifMatch: etag },
    );
    expect(updated.status).toBe(200);
    etag = requiredHeader(updated, 'etag');
    baseVersion = etagVersion(etag);
    const updatedData = (
      await json<Envelope<{ serverCursor: string; results: Array<{ versionId: string }> }>>(updated)
    ).data;
    baseCursor = updatedData.serverCursor;

    const staleUpdate = withHash({
      clientMutationId: randomUUID(),
      operation: 'update',
      baseRevisionVersion: baseVersion,
      featureId: feature.feature_id,
      baseVersionId: feature.feature_version_id,
      patch: { properties: { name: 'Bản stale không được ghi đè' } },
    });
    const conflictResponse = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/changes:batch`,
      { clientId, origin: 'recovery', baseCursor, mutations: [staleUpdate] },
      { ifMatch: etag },
    );
    expect(conflictResponse.status).toBe(200);
    const conflict = (
      await json<
        Envelope<{
          results: Array<{
            status: string;
            conflict: { code: string; currentVersionId: string; changedPaths: string[] };
          }>;
        }>
      >(conflictResponse)
    ).data.results[0]!;
    expect(conflict).toMatchObject({
      status: 'conflict',
      conflict: {
        code: 'FEATURE_VERSION_CHANGED',
        currentVersionId: updatedData.results[0]!.versionId,
      },
    });
    expect(conflict.conflict.changedPaths).toContain('properties.name');
    expect(requiredHeader(conflictResponse, 'etag')).toBe(etag);
    const currentName = (await AppDataSource.query(
      `SELECT version.properties->>'name' AS name
       FROM revision_features link JOIN feature_versions version ON version.id=link.feature_version_id
       WHERE link.revision_id=$1 AND link.feature_id=$2`,
      [revisionId, feature.feature_id],
    )) as Array<{ name: string }>;
    expect(currentName[0]!.name).toBe('Bản mới trên máy chủ');
  });

  it('serializes concurrent writers, pages the feed and returns typed cursor expiry/state errors', async () => {
    const workspace = await adminGet(editor, `/api/v1/admin/revisions/${revisionId}/workspace`);
    const etag = requiredHeader(workspace, 'etag');
    const baseVersion = etagVersion(etag);
    const baseCursor = (await json<Envelope<{ serverCursor: string }>>(workspace)).data
      .serverCursor;
    const concurrent = [0, 1].map((index) => ({
      clientId: randomUUID(),
      origin: 'editor',
      baseCursor,
      mutations: [
        withHash({
          clientMutationId: randomUUID(),
          operation: 'create',
          baseRevisionVersion: baseVersion,
          clientFeatureId: randomUUID(),
          feature: {
            geometry: { type: 'Point', coordinates: [108.26 + index * 0.001, 16.1] },
            geometryKind: 'point',
            properties: { name: `Concurrent ${index}` },
          },
        }),
      ],
    }));
    const responses = await Promise.all(
      concurrent.map((body) =>
        mutate(editor, `/api/v1/admin/revisions/${revisionId}/changes:batch`, body, {
          ifMatch: etag,
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const winner = responses.find((response) => response.status === 200)!;
    const currentEtag = requiredHeader(winner, 'etag');

    const firstFeed = await adminGet(
      reviewer,
      `/api/v1/admin/revisions/${revisionId}/changes?after=${encodeURIComponent(cursor(0))}&limit=3`,
    );
    expect(firstFeed.status).toBe(200);
    const firstPage =
      await json<
        Envelope<Array<{ serverCursor: string; actor: { id: string }; changedAt: string }>>
      >(firstFeed);
    expect(firstPage.data).toHaveLength(3);
    expect(firstPage.meta).toMatchObject({ hasMore: true, limit: 3 });
    expect(firstPage.data.map((item) => decodeCursor(item.serverCursor))).toEqual([1, 2, 3]);
    const secondFeed = await adminGet(
      reviewer,
      `/api/v1/admin/revisions/${revisionId}/changes?after=${encodeURIComponent(
        String(firstPage.meta.nextCursor),
      )}&limit=3`,
    );
    expect(secondFeed.status).toBe(200);
    const secondPage = await json<Envelope<Array<{ serverCursor: string }>>>(secondFeed);
    expect(decodeCursor(secondPage.data[0]!.serverCursor)).toBe(4);

    const revisionState = (await AppDataSource.query(
      `SELECT cursor_seq FROM layer_revisions WHERE id=$1`,
      [revisionId],
    )) as Array<{ cursor_seq: string }>;
    const currentCursor = Number(revisionState[0]!.cursor_seq);
    await AppDataSource.transaction(async (manager) => {
      await manager.query(`UPDATE layer_revisions SET change_cursor_floor=cursor_seq WHERE id=$1`, [
        revisionId,
      ]);
      await manager.query(
        `DELETE FROM revision_changes WHERE revision_id=$1 AND server_cursor <= $2`,
        [revisionId, currentCursor],
      );
    });
    const expired = await adminGet(
      editor,
      `/api/v1/admin/revisions/${revisionId}/changes?after=${encodeURIComponent(cursor(0))}`,
    );
    expect(expired.status).toBe(409);
    const expiredProblem = (await expired.json()) as {
      code: string;
      details: { workspaceUrl: string; currentEtag: string; currentCursor: string };
    };
    expect(expiredProblem).toMatchObject({
      code: 'SYNC_CURSOR_EXPIRED',
      details: {
        workspaceUrl: `/api/v1/admin/revisions/${revisionId}/workspace`,
        currentEtag,
        currentCursor: cursor(currentCursor),
      },
    });

    const submit = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}:submit`,
      { summary: 'Khóa revision để kiểm tra sync guard' },
      { idempotencyKey: randomUUID() },
    );
    expect(submit.status).toBe(202);
    const submitted = await adminGet(editor, `/api/v1/admin/revisions/${revisionId}/workspace`);
    const submittedEtag = requiredHeader(submitted, 'etag');
    const submittedData = (
      await json<Envelope<{ serverCursor: string; status: string }>>(submitted)
    ).data;
    expect(submittedData.status).toBe('in_review');
    const blockedMutation = withHash({
      clientMutationId: randomUUID(),
      operation: 'create',
      baseRevisionVersion: etagVersion(submittedEtag),
      clientFeatureId: randomUUID(),
      feature: {
        geometry: { type: 'Point', coordinates: [108.3, 16.12] },
        geometryKind: 'point',
        properties: { name: 'Không được ghi sau submit' },
      },
    });
    await expectProblem(
      mutate(
        editor,
        `/api/v1/admin/revisions/${revisionId}/changes:batch`,
        {
          clientId: randomUUID(),
          origin: 'editor',
          baseCursor: submittedData.serverCursor,
          mutations: [blockedMutation],
        },
        { ifMatch: submittedEtag },
      ),
      409,
      'REVISION_NOT_EDITABLE',
    );
  });

  it('publishes typed OpenAPI contracts for batch sync and the cursor feed', async () => {
    const response = await fetch(`${apiBaseUrl}/api/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<string, { operationId?: string; responses?: Record<string, unknown> }>
      >;
    };
    const batchOperation =
      document.paths['/api/v1/admin/revisions/{revisionId}/changes:batch']?.post;
    expect(batchOperation?.operationId).toBe('syncFeatureChangesBatch');
    expect(Object.hasOwn(batchOperation?.responses ?? {}, '200')).toBe(true);
    const feedOperation = document.paths['/api/v1/admin/revisions/{revisionId}/changes']?.get;
    expect(feedOperation?.operationId).toBe('listRevisionChanges');
    expect(Object.hasOwn(feedOperation?.responses ?? {}, '200')).toBe(true);
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function geometryFixtures(): Array<Record<string, unknown>> {
  return [
    feature('Point', [108.2, 16.05], 'point', 'Point'),
    feature(
      'MultiPoint',
      [
        [108.2, 16.05],
        [108.21, 16.06],
      ],
      'multipoint',
      'MultiPoint',
    ),
    feature(
      'LineString',
      [
        [108.2, 16.05],
        [108.22, 16.07],
      ],
      'line',
      'LineString',
    ),
    feature(
      'MultiLineString',
      [
        [
          [108.2, 16.05],
          [108.22, 16.07],
        ],
        [
          [108.23, 16.08],
          [108.24, 16.09],
        ],
      ],
      'multiline',
      'MultiLineString',
    ),
    feature(
      'Polygon',
      [
        [
          [108.2, 16.05],
          [108.22, 16.05],
          [108.22, 16.07],
          [108.2, 16.05],
        ],
      ],
      'polygon',
      'Polygon',
    ),
    feature(
      'MultiPolygon',
      [
        [
          [
            [108.2, 16.05],
            [108.21, 16.05],
            [108.21, 16.06],
            [108.2, 16.05],
          ],
        ],
      ],
      'multipolygon',
      'MultiPolygon',
    ),
    {
      geometry: { type: 'Point', coordinates: [108.23, 16.07] },
      geometryKind: 'circle',
      radiusM: 250,
      properties: { name: 'Circle' },
    },
  ];
}

function feature(
  type: string,
  coordinates: unknown,
  geometryKind: string,
  name: string,
): Record<string, unknown> {
  return { geometry: { type, coordinates }, geometryKind, properties: { name } };
}

function layerPayload(slug: string): Record<string, unknown> {
  return {
    slug,
    displayOrder: 0,
    defaultVisible: true,
    title: 'Feature sync fixtures',
    geometryMode: 'mixed',
    allowedGeometryKinds: [
      'point',
      'multipoint',
      'line',
      'multiline',
      'polygon',
      'multipolygon',
      'circle',
    ],
    fields: [
      {
        key: 'name',
        label: 'Tên',
        type: 'text',
        required: true,
        public: true,
        searchable: true,
      },
      {
        key: 'internal_note',
        label: 'Ghi chú nội bộ',
        type: 'long_text',
        public: false,
        offlineCache: false,
      },
    ],
    style: {
      point: { color: '#1A73E8', radius: 7, cluster: true },
      line: { color: '#1A73E8', width: 3 },
      polygon: { fillColor: '#EAF3FF', strokeColor: '#1A73E8' },
    },
    renderConfig: { minZoom: 6, maxZoom: 20, cluster: true, sourcePolicy: 'hybrid' },
    popupConfig: { titleField: 'name', fieldKeys: ['name'] },
  };
}

function withHash<T extends Record<string, unknown>>(mutation: T): T & { payloadHash: string } {
  const payload = structuredClone(mutation) as Record<string, unknown>;
  delete payload.payloadHash;
  return { ...mutation, payloadHash: sha256(JSON.stringify(canonical(payload))) };
}

async function restartApiContainer(): Promise<void> {
  const container = process.env.FEATURE_SYNC_DOCKER_API_CONTAINER ?? 'danangmap-api-1';
  await execFileAsync('docker', ['restart', container]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBaseUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // The socket is expected to be unavailable briefly while Docker restarts the API.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API container ${container} did not become ready after restart`);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cursor(value: number): string {
  return Buffer.from(String(value)).toString('base64url');
}

function decodeCursor(value: string): number {
  return Number(Buffer.from(value, 'base64url').toString('utf8'));
}

function etagVersion(etag: string): number {
  const match = /-v(\d+)"$/.exec(etag);
  if (!match?.[1]) throw new Error(`Invalid revision ETag: ${etag}`);
  return Number(match[1]);
}

async function adminGet(actor: Actor, path: string): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, { headers: { Cookie: actor.cookie } });
}

async function mutate(
  actor: Actor,
  path: string,
  body: Record<string, unknown>,
  options: { ifMatch?: string; idempotencyKey?: string } = {},
): Promise<Response> {
  return fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: actor.cookie,
      Origin: frontendOrigin,
      'X-CSRF-Token': actor.csrf,
      ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function expectProblem(responsePromise: Promise<Response>, status: number, code: string) {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  const problem = (await response.json()) as { code: string; requestId: string };
  expect(problem).toMatchObject({ code });
  expect(problem.requestId).toBeTruthy();
}

async function login(user: (typeof users)[keyof typeof users]): Promise<Actor> {
  const publicCsrfResponse = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`);
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
  const preauth = cookieValue(loginResponse, E2E_PREAUTH_COOKIE);
  const preauthCsrf = cookieValue(loginResponse, 'danangmap_csrf');
  const verifyResponse = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${E2E_PREAUTH_COOKIE}=${preauth}; danangmap_csrf=${preauthCsrf}`,
      Origin: frontendOrigin,
      'X-CSRF-Token': preauthCsrf,
    },
    body: JSON.stringify({ method: 'totp', code: totp(mfaSecret) }),
  });
  expect(verifyResponse.status).toBe(200);
  const session = cookieValue(verifyResponse, E2E_SESSION_COOKIE);
  const csrf = cookieValue(verifyResponse, 'danangmap_csrf');
  return { cookie: `${E2E_SESSION_COOKIE}=${session}; danangmap_csrf=${csrf}`, csrf };
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
