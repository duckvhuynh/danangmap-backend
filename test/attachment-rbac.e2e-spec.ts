import { createHash, createHmac, randomUUID } from 'node:crypto';
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

interface Actor {
  cookie: string;
  csrf: string;
}

interface Envelope<T> {
  data: T;
}

describe('attachment HTTP authorization matrix', () => {
  let actors: Record<keyof typeof users, Actor>;
  let editorAttachmentId: string | undefined;
  let adminAttachmentId: string | undefined;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      `UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])`,
      [Object.values(users).map((user) => user.id)],
    );
    actors = Object.fromEntries(
      await Promise.all(
        Object.entries(users).map(async ([role, user]) => [role, await login(user)] as const),
      ),
    ) as Record<keyof typeof users, Actor>;
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      for (const attachmentId of [editorAttachmentId, adminAttachmentId]) {
        if (!attachmentId) continue;
        await AppDataSource.query(
          `DELETE FROM attachments WHERE id=$1 AND NOT EXISTS (
             SELECT 1 FROM feature_version_attachments WHERE attachment_id=$1
           )`,
          [attachmentId],
        );
      }
      await AppDataSource.destroy();
    }
  });

  it('allows Editor to create a bounded quarantine upload intent', async () => {
    const response = await mutation(actors.editor, 'POST', '/api/v1/admin/uploads', uploadBody());
    expect(response.status).toBe(201);
    const body = await json<
      Envelope<{
        attachmentId: string;
        status: string;
        upload: { method: string; url: string; headers: Record<string, string> };
      }>
    >(response);
    const serialized = JSON.stringify(body);
    editorAttachmentId = body.data.attachmentId;
    expect(body.data).toMatchObject({ status: 'uploading' });
    expect(serialized).not.toContain('objectKey');
    expect(body.data.upload).toMatchObject({ method: 'PUT' });

    const upload = await fetch(body.data.upload.url, {
      method: 'PUT',
      headers: body.data.upload.headers,
      body: Buffer.from('a'),
    });
    expect(upload.status).toBe(200);
    const complete = await mutation(
      actors.editor,
      'POST',
      `/api/v1/admin/uploads/${editorAttachmentId}:complete`,
    );
    expect(complete.status).toBe(202);
    await expectStatus(editorAttachmentId, actors.editor, 'clean');

    const publicResponse = await fetch(
      `${apiBaseUrl}/api/v1/public/attachments/${editorAttachmentId}`,
    );
    expect(publicResponse.status).toBe(404);

    const deleted = await mutation(
      actors.editor,
      'DELETE',
      `/api/v1/admin/attachments/${editorAttachmentId}`,
    );
    expect(deleted.status).toBe(200);
  });

  it('allows System Admin to use Editor attachment capabilities', async () => {
    const created = await mutation(
      actors.systemAdmin,
      'POST',
      '/api/v1/admin/uploads',
      uploadBody(),
    );
    expect(created.status).toBe(201);
    adminAttachmentId = (await json<Envelope<{ attachmentId: string }>>(created)).data.attachmentId;
    const deleted = await mutation(
      actors.systemAdmin,
      'DELETE',
      `/api/v1/admin/attachments/${adminAttachmentId}`,
    );
    expect(deleted.status).toBe(200);
  });

  it.each(['reviewer', 'publisher'] as const)(
    'denies every attachment mutation to %s',
    async (role) => {
      const actor = actors[role];
      const revisionId = randomUUID();
      const featureId = randomUUID();
      const attachmentId = randomUUID();
      const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
        ['POST', '/api/v1/admin/uploads', uploadBody()],
        ['POST', `/api/v1/admin/uploads/${attachmentId}:complete`, undefined],
        ['DELETE', `/api/v1/admin/attachments/${attachmentId}`, undefined],
        [
          'POST',
          `/api/v1/admin/revisions/${revisionId}/features/${featureId}/attachments:bind`,
          { fieldKey: 'images', attachmentId, displayOrder: 0 },
        ],
        [
          'PATCH',
          `/api/v1/admin/revisions/${revisionId}/features/${featureId}/attachments:reorder`,
          { fieldKey: 'images', attachmentIds: [attachmentId] },
        ],
        [
          'DELETE',
          `/api/v1/admin/revisions/${revisionId}/features/${featureId}/attachments/${attachmentId}`,
          undefined,
        ],
      ];
      for (const [method, path, body] of cases) {
        const response = await mutation(actor, method, path, body, true);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ status: 403, code: 'ROLE_FORBIDDEN' });
      }
    },
  );

  it('keeps public delivery unauthenticated but fail-closed for unknown objects', async () => {
    const response = await fetch(`${apiBaseUrl}/api/v1/public/attachments/${randomUUID()}`);
    expect(response.status).toBe(404);
  });
});

function uploadBody() {
  const content = Buffer.from('a');
  return {
    purpose: 'feature_attachment',
    fileName: 'fixture.txt',
    contentType: 'text/plain',
    sizeBytes: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

async function mutation(
  actor: Actor,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  versioned = false,
) {
  return fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Cookie: actor.cookie,
      Origin: frontendOrigin,
      'X-CSRF-Token': actor.csrf,
      ...(versioned ? { 'If-Match': '"revision-1"', 'Idempotency-Key': randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function expectStatus(
  attachmentId: string,
  actor: Actor,
  expectedStatus: string,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${apiBaseUrl}/api/v1/admin/attachments/${attachmentId}`, {
      headers: { Cookie: actor.cookie },
    });
    expect(response.status).toBe(200);
    const body = await json<Envelope<{ status: string }>>(response);
    if (body.data.status === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Attachment ${attachmentId} did not reach ${expectedStatus}`);
}

async function login(user: (typeof users)[keyof typeof users]): Promise<Actor> {
  const csrfResponse = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`);
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
    headers: { Cookie: `__Host-danangmap_session=${session}; danangmap_csrf=${sessionCsrf}` },
  });
  const token = (await json<Envelope<{ csrfToken: string }>>(stableCsrf)).data.csrfToken;
  return {
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

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
