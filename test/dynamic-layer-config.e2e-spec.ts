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

describe('Dynamic layer configuration HTTP E2E', () => {
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
        await manager.query('DELETE FROM revision_participants WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
        await manager.query('DELETE FROM layer_fields WHERE revision_id=ANY($1::uuid[])', [
          revisionIds,
        ]);
      }
      if (layerIds.length) {
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
      await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
    });
    await AppDataSource.destroy();
  });

  it('persists a strict mixed draft exactly once and keeps it out of the public catalog', async () => {
    const suffix = randomUUID().slice(0, 8);
    const groupSlug = `cms-group-${suffix}`;
    const groupPayload = {
      slug: groupSlug,
      title: 'Hạ tầng đô thị',
      description: 'Nhóm cấu hình CMS qua HTTP thật.',
      displayOrder: 14,
      defaultVisible: false,
    };
    const groupKey = randomUUID();
    const groupResponse = await mutate(editor, '/api/v1/admin/layer-groups', groupPayload, 201, {
      idempotencyKey: groupKey,
    });
    const group = (await json<Envelope<{ id: string; displayOrder: number }>>(groupResponse)).data;
    groupIds.push(group.id);
    const groupReplay = await mutate(editor, '/api/v1/admin/layer-groups', groupPayload, 201, {
      idempotencyKey: groupKey,
    });
    expect((await json<Envelope<{ id: string }>>(groupReplay)).data.id).toBe(group.id);
    await expectProblem(
      mutate(editor, '/api/v1/admin/layer-groups', groupPayload, undefined, {
        idempotencyKey: randomUUID(),
      }),
      409,
      'SLUG_CONFLICT',
    );

    const layerSlug = `cms-mixed-${suffix}`;
    const layerPayload = mixedLayerPayload(layerSlug, group.id);
    for (const actor of [reviewer, publisher, systemAdmin]) {
      await expectProblem(
        mutate(actor, '/api/v1/admin/layers', layerPayload, undefined, {
          idempotencyKey: randomUUID(),
        }),
        403,
        'ROLE_FORBIDDEN',
      );
    }

    const invalidPayloads = [
      {
        ...mixedLayerPayload(`cms-invalid-schema-${suffix}`, group.id),
        fields: [
          {
            key: 'category',
            label: 'Phân loại',
            type: 'enum',
            public: true,
            options: [],
          },
        ],
        popupConfig: { titleField: 'category' },
      },
      {
        ...mixedLayerPayload(`cms-invalid-geometry-${suffix}`, group.id),
        geometryMode: 'point',
        allowedGeometryKinds: ['polygon'],
      },
      {
        ...mixedLayerPayload(`cms-invalid-style-${suffix}`, group.id),
        geometryMode: 'point',
        allowedGeometryKinds: ['point'],
        style: { polygon: { fillColor: '#EAF3FF' } },
        renderConfig: { minZoom: 8, maxZoom: 18, sourcePolicy: 'geojson' },
      },
      {
        ...mixedLayerPayload(`cms-invalid-popup-${suffix}`, group.id),
        popupConfig: { titleField: 'internal_note', fieldKeys: ['name'] },
      },
    ];
    for (const payload of invalidPayloads) {
      await expectProblem(
        mutate(editor, '/api/v1/admin/layers', payload, undefined, {
          idempotencyKey: randomUUID(),
        }),
        422,
        'SCHEMA_VIOLATION',
      );
    }

    const createKey = randomUUID();
    const createResponse = await mutate(editor, '/api/v1/admin/layers', layerPayload, 201, {
      idempotencyKey: createKey,
    });
    const created = (
      await json<
        Envelope<{
          layer: {
            id: string;
            groupId: string;
            displayOrder: number;
            defaultVisible: boolean;
          };
          draftRevision: { id: string; status: string };
        }>
      >(createResponse)
    ).data;
    layerIds.push(created.layer.id);
    revisionIds.push(created.draftRevision.id);
    expect(created.layer).toMatchObject({
      groupId: group.id,
      displayOrder: 17,
      defaultVisible: false,
    });
    expect(created.draftRevision.status).toBe('draft');
    const createEtag = requiredHeader(createResponse, 'etag');

    const replayResponse = await mutate(editor, '/api/v1/admin/layers', layerPayload, 201, {
      idempotencyKey: createKey,
    });
    const replay = (
      await json<Envelope<{ layer: { id: string }; draftRevision: { id: string } }>>(replayResponse)
    ).data;
    expect(replay.layer.id).toBe(created.layer.id);
    expect(replay.draftRevision.id).toBe(created.draftRevision.id);
    expect(requiredHeader(replayResponse, 'etag')).toBe(createEtag);

    await expectProblem(
      mutate(editor, '/api/v1/admin/layers', layerPayload, undefined, {
        idempotencyKey: randomUUID(),
      }),
      409,
      'SLUG_CONFLICT',
    );

    const revisionResponse = await fetch(
      `${apiBaseUrl}/api/v1/admin/revisions/${created.draftRevision.id}`,
      { headers: { Cookie: editor.cookie } },
    );
    expect(revisionResponse.status).toBe(200);
    expect(requiredHeader(revisionResponse, 'etag')).toBe(createEtag);
    const reloaded = (
      await json<
        Envelope<{
          revision: {
            geometryMode: string;
            allowedGeometryKinds: string[];
            style: Record<string, unknown>;
            renderConfig: Record<string, unknown>;
            popupConfig: Record<string, unknown>;
          };
          fields: Array<Record<string, unknown>>;
        }>
      >(revisionResponse)
    ).data;
    expect(reloaded.revision).toMatchObject({
      geometryMode: 'mixed',
      allowedGeometryKinds: ['point', 'polygon', 'circle'],
      style: {
        point: {
          color: '#1A73E8',
          radius: 8,
          strokeColor: '#FFFFFF',
          strokeWidth: 2,
          cluster: true,
        },
        polygon: {
          fillColor: '#EAF3FF',
          fillOpacity: 0.35,
          strokeColor: '#1A73E8',
          strokeWidth: 2,
        },
      },
      renderConfig: { minZoom: 7, maxZoom: 19, cluster: true, sourcePolicy: 'hybrid' },
      popupConfig: {
        titleField: 'name',
        subtitleField: 'category',
        fieldKeys: ['name', 'category'],
        showCoordinates: true,
      },
    });
    expect(reloaded.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'name',
          label: 'Tên đối tượng',
          icon: 'map-pin',
          required: true,
          public: true,
          searchable: true,
          filterable: true,
          validation: { minLength: 2, maxLength: 120 },
        }),
        expect.objectContaining({
          key: 'category',
          type: 'enum',
          defaultValue: 'public-service',
          options: ['public-service', 'community'],
        }),
        expect.objectContaining({
          key: 'internal_note',
          public: false,
          sensitive: true,
          offlineCache: false,
        }),
      ]),
    );

    const adminLayers = await fetch(`${apiBaseUrl}/api/v1/admin/layers`, {
      headers: { Cookie: editor.cookie },
    });
    expect(adminLayers.status).toBe(200);
    const list = (await json<Envelope<Array<Record<string, unknown>>>>(adminLayers)).data;
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.layer.id,
          groupId: group.id,
          displayOrder: 17,
          defaultVisible: false,
          revisionId: created.draftRevision.id,
          status: 'draft',
        }),
      ]),
    );

    const catalogResponse = await fetch(`${apiBaseUrl}/api/v1/public/layers`);
    expect(catalogResponse.status).toBe(200);
    const catalog = (await json<Envelope<Array<{ slug: string }>>>(catalogResponse)).data;
    expect(catalog.some((item) => item.slug === layerSlug)).toBe(false);
    await expectProblem(
      fetch(`${apiBaseUrl}/api/v1/public/layers/${layerSlug}`),
      404,
      'LAYER_NOT_FOUND',
    );

    const auditRows = (await AppDataSource.query(
      `SELECT action,resource_id AS "resourceId"
       FROM audit_logs
       WHERE actor_id=$1 AND resource_id=ANY($2::uuid[]) AND occurred_at >= $3
       ORDER BY occurred_at`,
      [editor.id, [group.id, created.layer.id], startedAt],
    )) as Array<{ action: string; resourceId: string }>;
    expect(auditRows).toEqual([
      { action: 'layer_group.created', resourceId: group.id },
      { action: 'layer.created', resourceId: created.layer.id },
    ]);
  });
});

function mixedLayerPayload(slug: string, groupId: string): Record<string, unknown> {
  return {
    slug,
    groupId,
    displayOrder: 17,
    defaultVisible: false,
    title: 'Đối tượng đô thị hỗn hợp',
    description: 'Point, Polygon và circle cùng một layer.',
    geometryMode: 'mixed',
    allowedGeometryKinds: ['point', 'polygon', 'circle'],
    fields: [
      {
        key: 'name',
        label: 'Tên đối tượng',
        type: 'text',
        icon: 'map-pin',
        required: true,
        public: true,
        searchable: true,
        filterable: true,
        validation: { minLength: 2, maxLength: 120 },
        displayOrder: 10,
      },
      {
        key: 'category',
        label: 'Phân loại',
        type: 'enum',
        public: true,
        filterable: true,
        defaultValue: 'public-service',
        options: ['public-service', 'community'],
        displayOrder: 20,
      },
      {
        key: 'internal_note',
        label: 'Ghi chú nội bộ',
        type: 'long_text',
        public: false,
        sensitive: true,
        offlineCache: false,
        displayOrder: 30,
      },
    ],
    style: {
      point: {
        color: '#1A73E8',
        radius: 8,
        strokeColor: '#FFFFFF',
        strokeWidth: 2,
        cluster: true,
      },
      polygon: {
        fillColor: '#EAF3FF',
        fillOpacity: 0.35,
        strokeColor: '#1A73E8',
        strokeWidth: 2,
      },
    },
    renderConfig: { minZoom: 7, maxZoom: 19, cluster: true, sourcePolicy: 'hybrid' },
    popupConfig: {
      titleField: 'name',
      subtitleField: 'category',
      fieldKeys: ['name', 'category'],
      showCoordinates: true,
    },
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
