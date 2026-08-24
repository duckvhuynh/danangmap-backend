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

describe('Controlled publication HTTP E2E', () => {
  const startedAt = new Date();
  const groupIds: string[] = [];
  const layerIds: string[] = [];
  const revisionIds: string[] = [];
  let editor: AuthenticatedActor;
  let reviewer: AuthenticatedActor;
  let publisher: AuthenticatedActor;
  let systemAdmin: AuthenticatedActor;
  let layerId: string;
  let revisionId: string;
  let layerSlug: string;
  let firstSnapshotId: string;

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
    await AppDataSource.query(
      'DROP TRIGGER IF EXISTS trg_e2e_fail_publication_pointer ON layer_publications',
    ).catch(() => undefined);
    await AppDataSource.query(
      'DROP FUNCTION IF EXISTS danangmap_e2e_fail_publication_pointer()',
    ).catch(() => undefined);
    if (AppDataSource.isInitialized) {
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
        if (layerIds.length) {
          await manager.query(
            `DELETE FROM audit_logs
             WHERE id IN (SELECT audit_id FROM audit_layer_scopes WHERE layer_id=ANY($1::uuid[]))`,
            [layerIds],
          );
        }
        if (revisionIds.length) {
          await manager.query('DELETE FROM workflow_events WHERE revision_id=ANY($1::uuid[])', [
            revisionIds,
          ]);
          await manager.query(
            'DELETE FROM revision_participants WHERE revision_id=ANY($1::uuid[])',
            [revisionIds],
          );
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
    }
  });

  it('keeps a draft private, enforces role separation, and publishes exactly one generation', async () => {
    const groupKey = randomUUID();
    const adminGroup = await mutate(
      systemAdmin,
      '/api/v1/admin/layer-groups',
      {
        slug: `workflow-admin-${randomUUID().slice(0, 8)}`,
        title: 'System Admin authoring capability',
      },
      201,
      { idempotencyKey: randomUUID() },
    );
    groupIds.push((await json<Envelope<{ id: string }>>(adminGroup)).data.id);
    const groupSlug = `workflow-group-${randomUUID().slice(0, 8)}`;
    const createGroup = await mutate(
      editor,
      '/api/v1/admin/layer-groups',
      {
        slug: groupSlug,
        title: 'Nhóm kiểm thử workflow',
        description: 'Group được tạo qua HTTP thật.',
        displayOrder: 70,
        defaultVisible: true,
      },
      201,
      { idempotencyKey: groupKey },
    );
    const group = (await json<Envelope<{ id: string }>>(createGroup)).data;
    groupIds.push(group.id);
    const groupReplay = await mutate(
      editor,
      '/api/v1/admin/layer-groups',
      {
        slug: groupSlug,
        title: 'Nhóm kiểm thử workflow',
        description: 'Group được tạo qua HTTP thật.',
        displayOrder: 70,
        defaultVisible: true,
      },
      201,
      { idempotencyKey: groupKey },
    );
    expect((await json<Envelope<{ id: string }>>(groupReplay)).data.id).toBe(group.id);
    layerSlug = `workflow-e2e-${randomUUID().slice(0, 8)}`;
    const createLayer = await mutate(
      editor,
      '/api/v1/admin/layers',
      {
        slug: layerSlug,
        groupId: group.id,
        title: 'Điểm dịch vụ E2E',
        geometryMode: 'point',
        allowedGeometryKinds: ['point'],
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
            key: 'internal_note',
            label: 'Ghi chú nội bộ',
            type: 'long_text',
            public: false,
            sensitive: true,
            offlineCache: false,
          },
        ],
        style: {
          point: {
            color: '#1A73E8',
            radius: 7,
            strokeColor: '#FFFFFF',
            strokeWidth: 2,
            cluster: true,
          },
        },
        renderConfig: { sourcePolicy: 'geojson', minZoom: 8, maxZoom: 18, cluster: true },
        popupConfig: { titleField: 'name', fieldKeys: ['name'], showCoordinates: false },
      },
      201,
      { idempotencyKey: randomUUID() },
    );
    const created = (
      await json<
        Envelope<{
          layer: { id: string };
          draftRevision: { id: string; status: string };
        }>
      >(createLayer)
    ).data;
    layerId = created.layer.id;
    revisionId = created.draftRevision.id;
    layerIds.push(layerId);
    revisionIds.push(revisionId);
    let revisionEtag = requiredHeader(createLayer, 'etag');
    expect(created.draftRevision.status).toBe('draft');
    const revisionResponse = await fetch(`${apiBaseUrl}/api/v1/admin/revisions/${revisionId}`, {
      headers: { Cookie: editor.cookie },
    });
    expect(revisionResponse.status).toBe(200);
    expect(requiredHeader(revisionResponse, 'etag')).toBe(revisionEtag);
    const revisionRoundTrip = (
      await json<
        Envelope<{
          revision: {
            style: Record<string, unknown>;
            renderConfig: Record<string, unknown>;
            popupConfig: Record<string, unknown>;
          };
          fields: Array<{ key: string; validation: Record<string, unknown> }>;
        }>
      >(revisionResponse)
    ).data;
    expect(revisionRoundTrip.revision.style).toEqual({
      point: {
        color: '#1A73E8',
        radius: 7,
        strokeColor: '#FFFFFF',
        strokeWidth: 2,
        cluster: true,
      },
    });
    expect(revisionRoundTrip.revision.renderConfig).toEqual({
      sourcePolicy: 'geojson',
      minZoom: 8,
      maxZoom: 18,
      cluster: true,
    });
    expect(revisionRoundTrip.revision.popupConfig).toEqual({
      titleField: 'name',
      fieldKeys: ['name'],
      showCoordinates: false,
    });
    expect(revisionRoundTrip.fields.find((field) => field.key === 'name')?.validation).toEqual({
      minLength: 2,
      maxLength: 120,
    });
    await expectPublicMissing(layerSlug);

    const createFeature = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}/features`,
      {
        geometry: { type: 'Point', coordinates: [108.2208, 16.0678] },
        geometryKind: 'point',
        properties: {
          name: 'Điểm dịch vụ chưa công bố',
          internal_note: 'Không được rò rỉ ra public',
        },
      },
      201,
      { idempotencyKey: randomUUID(), ifMatch: revisionEtag },
    );
    revisionEtag = requiredHeader(createFeature, 'etag');
    expect(revisionEtag).toContain('-v2"');
    await expectPublicMissing(layerSlug);

    await expectProblem(
      mutate(
        systemAdmin,
        `/api/v1/admin/revisions/${randomUUID()}:submit`,
        { summary: 'System Admin có quyền submit nhưng revision không tồn tại' },
        undefined,
        { idempotencyKey: randomUUID() },
      ),
      404,
      'NOT_FOUND',
    );
    const submitKey = randomUUID();
    const submit = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}:submit`,
      { summary: 'Gửi revision qua kiểm duyệt' },
      202,
      { idempotencyKey: submitKey },
    );
    expect((await json<Envelope<{ status: string }>>(submit)).data.status).toBe('in_review');
    const submitReplay = await mutate(
      editor,
      `/api/v1/admin/revisions/${revisionId}:submit`,
      { summary: 'Gửi revision qua kiểm duyệt' },
      202,
      { idempotencyKey: submitKey },
    );
    expect((await json<Envelope<{ status: string }>>(submitReplay)).data.status).toBe('in_review');
    await expectPublicMissing(layerSlug);

    await expectProblem(
      mutate(editor, `/api/v1/admin/revisions/${revisionId}:approve`, { comment: 'Tự duyệt' }),
      403,
      'ROLE_FORBIDDEN',
    );
    await AppDataSource.query(
      `INSERT INTO revision_participants(revision_id,user_id,participation_type)
       VALUES($1,$2,'edit') ON CONFLICT DO NOTHING`,
      [revisionId, reviewer.id],
    );
    await expectProblem(
      mutate(
        reviewer,
        `/api/v1/admin/revisions/${revisionId}:approve`,
        { comment: 'Không được tự duyệt khi đã tham gia edit' },
        undefined,
        { idempotencyKey: randomUUID() },
      ),
      403,
      'SEPARATION_OF_DUTIES',
    );
    await AppDataSource.query(
      `DELETE FROM revision_participants
       WHERE revision_id=$1 AND user_id=$2 AND participation_type='edit'`,
      [revisionId, reviewer.id],
    );
    const approve = await mutate(
      reviewer,
      `/api/v1/admin/revisions/${revisionId}:approve`,
      { comment: 'Dữ liệu hợp lệ' },
      201,
      { idempotencyKey: randomUUID() },
    );
    expect((await json<Envelope<{ status: string }>>(approve)).data.status).toBe('approved');
    await expectPublicMissing(layerSlug);

    await expectProblem(
      mutate(reviewer, `/api/v1/admin/revisions/${revisionId}:publish`, {
        releaseNote: 'Reviewer không được publish',
      }),
      403,
      'ROLE_FORBIDDEN',
    );
    await AppDataSource.query(
      `INSERT INTO revision_participants(revision_id,user_id,participation_type)
       VALUES($1,$2,'edit') ON CONFLICT DO NOTHING`,
      [revisionId, publisher.id],
    );
    await expectProblem(
      mutate(
        publisher,
        `/api/v1/admin/revisions/${revisionId}:publish`,
        { releaseNote: 'Publisher đã tham gia edit phải bị chặn' },
        undefined,
        { idempotencyKey: randomUUID() },
      ),
      403,
      'SEPARATION_OF_DUTIES',
    );
    await AppDataSource.query(
      `DELETE FROM revision_participants
       WHERE revision_id=$1 AND user_id=$2 AND participation_type='edit'`,
      [revisionId, publisher.id],
    );

    const publishKey = randomUUID();
    const publish = await mutate(
      systemAdmin,
      `/api/v1/admin/revisions/${revisionId}:publish`,
      { releaseNote: 'Công bố generation đầu tiên' },
      202,
      { idempotencyKey: publishKey },
    );
    const publication = (
      await json<Envelope<{ snapshotId: string; generation: number; status: string }>>(publish)
    ).data;
    firstSnapshotId = publication.snapshotId;
    expect(publication).toMatchObject({ generation: 1, status: 'completed' });
    const [publishAudit] = (await AppDataSource.query(
      `SELECT actor_role AS "actorRole" FROM audit_logs
       WHERE action='revision.published' AND resource_id=$1
       ORDER BY occurred_at DESC,id DESC LIMIT 1`,
      [revisionId],
    )) as Array<{ actorRole: string }>;
    expect(publishAudit?.actorRole).toBe('system_admin');
    const publishReplay = await mutate(
      systemAdmin,
      `/api/v1/admin/revisions/${revisionId}:publish`,
      { releaseNote: 'Công bố generation đầu tiên' },
      202,
      { idempotencyKey: publishKey },
    );
    expect(
      (await json<Envelope<{ snapshotId: string; generation: number }>>(publishReplay)).data,
    ).toMatchObject({ snapshotId: firstSnapshotId, generation: 1 });

    const publicLayer = await fetch(`${apiBaseUrl}/api/v1/public/layers/${layerSlug}`);
    expect(publicLayer.status).toBe(200);
    expect(
      (await json<Envelope<{ generation: number; snapshotId: string }>>(publicLayer)).data,
    ).toMatchObject({ generation: 1, snapshotId: firstSnapshotId });
    const publicFeatures = await fetch(
      `${apiBaseUrl}/api/v1/public/layers/${layerSlug}/features?limit=10`,
    );
    expect(publicFeatures.status).toBe(200);
    const collection = (await publicFeatures.json()) as {
      features: Array<{ properties: Record<string, unknown> }>;
      meta: { generation: number };
    };
    expect(collection.meta.generation).toBe(1);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]?.properties).toEqual({ name: 'Điểm dịch vụ chưa công bố' });
    expect(JSON.stringify(collection)).not.toContain('internal_note');

    const snapshotRows = (await AppDataSource.query(
      `SELECT id,generation::integer AS generation FROM publication_snapshots
       WHERE layer_id=$1 ORDER BY generation`,
      [layerId],
    )) as Array<{ id: string; generation: number }>;
    expect(snapshotRows).toEqual([{ id: firstSnapshotId, generation: 1 }]);
  });

  it('rolls back a failed publish transaction without moving the active pointer', async () => {
    const [nextRevision] = (await AppDataSource.query(
      `INSERT INTO layer_revisions(
         layer_id,revision_no,status,title,description,geometry_mode,allowed_geometry_kinds,
         style,render_config,popup_config,schema_version,lock_version,cursor_seq,created_by,
         supersedes_revision_id,submitted_at,approved_at
       )
       SELECT layer_id,revision_no+1,'approved',title,description,geometry_mode,allowed_geometry_kinds,
         style,render_config,popup_config,schema_version,1,cursor_seq,created_by,id,now(),now()
       FROM layer_revisions WHERE id=$1 RETURNING id`,
      [revisionId],
    )) as Array<{ id: string }>;
    const failureRevisionId = nextRevision!.id;
    revisionIds.push(failureRevisionId);
    await AppDataSource.query(
      `INSERT INTO layer_fields(
         revision_id,key,label,description,type,icon,required,public,searchable,filterable,
         sortable,sensitive,offline_cache,default_value,validation,options,display_order
       ) SELECT $2,key,label,description,type,icon,required,public,searchable,filterable,
         sortable,sensitive,offline_cache,default_value,validation,options,display_order
         FROM layer_fields WHERE revision_id=$1`,
      [revisionId, failureRevisionId],
    );
    await AppDataSource.query(
      `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
       SELECT $2,feature_id,feature_version_id,ordinal FROM revision_features WHERE revision_id=$1`,
      [revisionId, failureRevisionId],
    );
    await AppDataSource.query(
      `INSERT INTO revision_participants(revision_id,user_id,participation_type)
       VALUES($1,$2,'edit'),($1,$3,'review')`,
      [failureRevisionId, editor.id, reviewer.id],
    );
    const [before] = (await AppDataSource.query(
      `SELECT lp.active_snapshot_id AS "activeSnapshotId",s.generation::integer AS generation,
              (SELECT count(*)::integer FROM publication_snapshots WHERE layer_id=lp.layer_id) AS "snapshotCount"
       FROM layer_publications lp JOIN publication_snapshots s ON s.id=lp.active_snapshot_id
       WHERE lp.layer_id=$1`,
      [layerId],
    )) as Array<{ activeSnapshotId: string; generation: number; snapshotCount: number }>;
    expect(before).toEqual({ activeSnapshotId: firstSnapshotId, generation: 1, snapshotCount: 1 });

    await AppDataSource.query(`
      CREATE OR REPLACE FUNCTION danangmap_e2e_fail_publication_pointer()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.layer_id = '${layerId}'::uuid THEN
          RAISE EXCEPTION 'intentional E2E publication pointer failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await AppDataSource.query(`
      CREATE TRIGGER trg_e2e_fail_publication_pointer
      BEFORE UPDATE OF active_snapshot_id ON layer_publications
      FOR EACH ROW EXECUTE FUNCTION danangmap_e2e_fail_publication_pointer()
    `);
    const failedPublish = await mutate(
      publisher,
      `/api/v1/admin/revisions/${failureRevisionId}:publish`,
      { releaseNote: 'Phải rollback toàn bộ transaction' },
      undefined,
      { idempotencyKey: randomUUID() },
    );
    await expectProblem(Promise.resolve(failedPublish), 500, 'INTERNAL_ERROR');
    await AppDataSource.query(
      'DROP TRIGGER IF EXISTS trg_e2e_fail_publication_pointer ON layer_publications',
    );
    await AppDataSource.query('DROP FUNCTION IF EXISTS danangmap_e2e_fail_publication_pointer()');

    const [after] = (await AppDataSource.query(
      `SELECT lp.active_snapshot_id AS "activeSnapshotId",s.generation::integer AS generation,
              (SELECT count(*)::integer FROM publication_snapshots WHERE layer_id=lp.layer_id) AS "snapshotCount"
       FROM layer_publications lp JOIN publication_snapshots s ON s.id=lp.active_snapshot_id
       WHERE lp.layer_id=$1`,
      [layerId],
    )) as Array<{ activeSnapshotId: string; generation: number; snapshotCount: number }>;
    expect(after).toEqual(before);
    const [revision] = (await AppDataSource.query(
      'SELECT status FROM layer_revisions WHERE id=$1',
      [failureRevisionId],
    )) as Array<{ status: string }>;
    expect(revision?.status).toBe('approved');
    const publicLayer = await fetch(`${apiBaseUrl}/api/v1/public/layers/${layerSlug}`);
    expect(publicLayer.status).toBe(200);
    expect((await json<Envelope<{ generation: number }>>(publicLayer)).data.generation).toBe(1);
  });
});

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
  const code = totp(mfaSecret);
  const verifyResponse = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `__Host-danangmap_preauth=${preauth}; danangmap_csrf=${preauthCsrf}`,
      Origin: frontendOrigin,
      'X-CSRF-Token': preauthCsrf,
    },
    body: JSON.stringify({ method: 'totp', code }),
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
  body: Record<string, unknown>,
  expectedStatus?: number,
  options: { idempotencyKey?: string; ifMatch?: string } = {},
): Promise<Response> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: actor.cookie,
      Origin: frontendOrigin,
      'X-CSRF-Token': actor.csrf,
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.ifMatch ? { 'If-Match': options.ifMatch } : {}),
    },
    body: JSON.stringify(body),
  });
  if (expectedStatus !== undefined) expect(response.status).toBe(expectedStatus);
  return response;
}

async function expectProblem(responsePromise: Promise<Response>, status: number, code: string) {
  const response = await responsePromise;
  expect(response.status).toBe(status);
  const problem = (await response.json()) as { status: number; code: string; requestId: string };
  expect(problem).toMatchObject({ status, code });
  expect(problem.requestId).toBeTruthy();
}

async function expectPublicMissing(slug: string) {
  const response = await fetch(`${apiBaseUrl}/api/v1/public/layers/${slug}`);
  expect(response.status).toBe(404);
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
