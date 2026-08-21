import { createDecipheriv, createHash, createHmac, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Client } from 'minio';
import AppDataSource from '../src/database/data-source';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
const allowedOrigin = 'http://localhost:3000';
const adminId = '00000000-0000-4000-8000-000000000001';
const editorId = '00000000-0000-4000-8000-000000000002';
const reviewerId = '00000000-0000-4000-8000-000000000003';
const publisherId = '00000000-0000-4000-8000-000000000004';
const mfaSecret = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

jest.setTimeout(120_000);

class CookieJar {
  private readonly values = new Map<string, string>();

  absorb(response: Response): void {
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator < 1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue.length === 0 || /max-age=0/i.test(value)) this.values.delete(name);
      else this.values.set(name, cookieValue);
    }
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  header(): string {
    return [...this.values.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

interface Envelope<T> {
  data: T;
  meta: { requestId: string; nextCursor?: string | null; hasMore?: boolean };
}

interface ImportJob {
  id: string;
  status: string;
  counts: { total: number; valid: number; invalid: number; applied: number; skipped: number };
  inspection: { sheets: string[]; selectedSheet: string | null };
  failureCode: string | null;
}

describe('Secure user import HTTP lifecycle', () => {
  const startedAt = new Date();
  const suffix = randomUUID().slice(0, 8);
  const uploadKeys: string[] = [];
  const applyKeys: string[] = [];
  const jobIds: string[] = [];
  const importedUserIds: string[] = [];
  const inviteIds: string[] = [];
  let adminJar: CookieJar;
  let editorJar: CookieJar;
  let reviewerJar: CookieJar;
  let publisherJar: CookieJar;
  let csv: Buffer;
  let xlsx: Buffer;
  let logicalRows: string[][];
  const minio = new Client({
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'danangmap',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'danangmap-local-secret',
  });

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])',
      [[adminId, editorId, reviewerId, publisherId]],
    );
    logicalRows = [
      ['email', 'username', 'displayName', 'role'],
      [
        `import-editor-${suffix}@example.gov.vn`,
        `import.editor.${suffix}`,
        'Biên tập Đà Nẵng',
        'editor',
      ],
      [
        `import-admin-${suffix}@example.gov.vn`,
        `import.admin.${suffix}`,
        'Quản trị nhập liệu',
        'system_admin',
      ],
      [
        `duplicate-${suffix}@example.gov.vn`,
        `duplicate.one.${suffix}`,
        'Dòng trùng một',
        'reviewer',
      ],
      [
        `duplicate-${suffix}@example.gov.vn`,
        `duplicate.two.${suffix}`,
        'Dòng trùng hai',
        'publisher',
      ],
      [`invalid-role-${suffix}@example.gov.vn`, `invalid.role.${suffix}`, 'Vai trò sai', 'owner'],
    ];
    csv = Buffer.from(logicalRows.map((row) => row.join(',')).join('\n'));
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Hướng dẫn').addRow(['Không xử lý sheet này']);
    workbook.addWorksheet('Tài khoản').addRows(logicalRows);
    xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    adminJar = await authenticatedJar(
      'system-admin@danangmap.local',
      process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-2026!',
    );
    editorJar = await authenticatedJar(
      'editor@danangmap.local',
      process.env.SEED_EDITOR_PASSWORD ?? 'ChangeMe-Editor-2026!',
    );
    reviewerJar = await authenticatedJar(
      'reviewer@danangmap.local',
      process.env.SEED_REVIEWER_PASSWORD ?? 'ChangeMe-Reviewer-2026!',
    );
    publisherJar = await authenticatedJar(
      'publisher@danangmap.local',
      process.env.SEED_PUBLISHER_PASSWORD ?? 'ChangeMe-Publisher-2026!',
    );
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    const discoveredJobs = (await AppDataSource.query(
      'SELECT id FROM user_import_jobs WHERE file_name LIKE $1',
      [`%${suffix}%`],
    )) as Array<{ id: string }>;
    for (const job of discoveredJobs) {
      if (!jobIds.includes(job.id)) jobIds.push(job.id);
    }
    const storedObjects = (await AppDataSource.query(
      'SELECT object_key FROM user_import_jobs WHERE id=ANY($1::uuid[]) AND object_key IS NOT NULL',
      [jobIds],
    )) as Array<{ object_key: string }>;
    for (const object of storedObjects) {
      await minio.removeObject('danangmap', object.object_key).catch(() => undefined);
    }
    await AppDataSource.transaction(async (manager) => {
      await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      await manager.query(
        `DELETE FROM audit_logs WHERE occurred_at >= $1 AND (
          resource_id=ANY($2::uuid[]) OR resource_id=ANY($3::uuid[])
          OR metadata->>'jobId'=ANY($2::text[])
          OR actor_id=ANY($4::uuid[])
        )`,
        [startedAt, jobIds, inviteIds, importedUserIds],
      );
      await manager.query('DELETE FROM admin_sessions WHERE user_id=ANY($1::uuid[])', [
        [adminId, editorId, reviewerId, publisherId, ...importedUserIds],
      ]);
      await manager.query('DELETE FROM command_receipts WHERE idempotency_key=ANY($1::uuid[])', [
        [...uploadKeys, ...applyKeys],
      ]);
      await manager.query('DELETE FROM mail_outbox WHERE invite_id=ANY($1::uuid[])', [inviteIds]);
      await manager.query('DELETE FROM invites WHERE id=ANY($1::uuid[])', [inviteIds]);
      await manager.query('DELETE FROM user_import_jobs WHERE id=ANY($1::uuid[])', [jobIds]);
      await manager.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [importedUserIds]);
      await manager.query(
        `DELETE FROM audit_logs WHERE occurred_at >= $1
         AND actor_id=ANY($2::uuid[]) AND action LIKE 'auth.%'`,
        [startedAt, [adminId, editorId, reviewerId, publisherId]],
      );
      await manager.query(
        'UPDATE user_mfa_methods SET last_used_time_step=NULL WHERE user_id=ANY($1::uuid[])',
        [[adminId, editorId, reviewerId, publisherId]],
      );
      await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
    });
    await AppDataSource.destroy();
  });

  it('enforces System Admin, Origin, CSRF, size, and durable upload idempotency', async () => {
    for (const jar of [editorJar, reviewerJar, publisherJar]) {
      const denied = await upload(jar, csv, `users-${suffix}.csv`, randomUUID());
      await readProblem(denied, 403, 'ROLE_FORBIDDEN');
    }

    const missingCsrf = await upload(adminJar, csv, `users-${suffix}.csv`, randomUUID(), '');
    await readProblem(missingCsrf, 403, 'CSRF_INVALID');

    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    const tooLarge = await upload(adminJar, oversized, 'oversized.csv', randomUUID());
    expect(tooLarge.status).toBe(413);

    const key = randomUUID();
    uploadKeys.push(key);
    const first = await upload(adminJar, csv, `users-${suffix}.csv`, key);
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as Envelope<ImportJob>;
    jobIds.push(firstBody.data.id);
    const replay = await upload(adminJar, csv, `users-${suffix}.csv`, key);
    expect(replay.status).toBe(202);
    const replayBody = (await replay.json()) as Envelope<ImportJob>;
    expect(replayBody.data.id).toBe(firstBody.data.id);

    const changed = await upload(
      adminJar,
      Buffer.from(`${csv.toString()}\nchanged@example.gov.vn,changed.${suffix},Changed,editor`),
      `users-${suffix}.csv`,
      key,
    );
    await readProblem(changed, 409, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('produces equivalent CSV/XLSX validation with deterministic safe issues and no users', async () => {
    const csvJob = jobIds[0]!;
    await waitForJob(csvJob, 'inspected');
    const xlsxKey = randomUUID();
    uploadKeys.push(xlsxKey);
    const xlsxUpload = await upload(adminJar, xlsx, `users-${suffix}.xlsx`, xlsxKey);
    expect(xlsxUpload.status).toBe(202);
    const xlsxBody = (await xlsxUpload.json()) as Envelope<ImportJob>;
    const xlsxJob = xlsxBody.data.id;
    jobIds.push(xlsxJob);
    const inspectedXlsx = await waitForJob(xlsxJob, 'inspected');
    expect(inspectedXlsx.inspection.sheets).toEqual(['Hướng dẫn', 'Tài khoản']);

    const before = await identityEffectCount();
    const csvValidate = await command(csvJob, 'validate', {});
    expect(csvValidate.status).toBe(202);
    const xlsxValidate = await command(xlsxJob, 'validate', { sheet: 'Tài khoản' });
    expect(xlsxValidate.status).toBe(202);
    const [csvReady, xlsxReady] = await Promise.all([
      waitForJob(csvJob, 'ready'),
      waitForJob(xlsxJob, 'ready'),
    ]);
    expect(csvReady.counts).toMatchObject({ total: 5, valid: 2, invalid: 3 });
    expect(xlsxReady.counts).toEqual(csvReady.counts);
    expect(await identityEffectCount()).toEqual(before);

    const normalized = await Promise.all(
      [csvJob, xlsxJob].map(async (jobId) => ({
        rows: (await AppDataSource.query(
          `SELECT row_number,email_normalized,username_normalized,display_name,role,valid
           FROM user_import_rows WHERE job_id=$1 ORDER BY row_number`,
          [jobId],
        )) as Array<Record<string, unknown>>,
        issues: (await AppDataSource.query(
          `SELECT row_number,code,field FROM user_import_issues
           WHERE job_id=$1 ORDER BY row_number,code,field`,
          [jobId],
        )) as Array<{ row_number: number; code: string; field: string | null }>,
      })),
    );
    expect(normalized[1]).toEqual(normalized[0]);
    expect((normalized[0]?.issues as Array<{ code: string }>).map((issue) => issue.code)).toEqual([
      'USER_IMPORT_DUPLICATE_EMAIL',
      'USER_IMPORT_DUPLICATE_EMAIL',
      'USER_IMPORT_ROLE_INVALID',
    ]);
  });

  it('atomically applies valid invite rows once under concurrent replay and cleans quarantine', async () => {
    const jobId = jobIds[0]!;
    const key = randomUUID();
    applyKeys.push(key);
    const before = await identityEffectCount();
    const [first, replay] = await Promise.all([
      command(jobId, 'apply', { validRowPolicy: 'invite' }, key),
      command(jobId, 'apply', { validRowPolicy: 'invite' }, key),
    ]);
    expect([first.status, replay.status]).toEqual([202, 202]);
    const completed = await waitForJob(jobId, 'completed');
    expect(completed.counts).toEqual({ total: 5, valid: 2, invalid: 3, applied: 2, skipped: 3 });
    const after = await identityEffectCount();
    expect(after.invites - before.invites).toBe(2);
    expect(after.outbox - before.outbox).toBe(2);

    const importInvites = (await AppDataSource.query(
      `SELECT invite_id FROM user_import_invites WHERE job_id=$1 ORDER BY row_number`,
      [jobId],
    )) as Array<{ invite_id: string }>;
    inviteIds.push(...importInvites.map((row) => row.invite_id));
    expect(new Set(inviteIds).size).toBe(2);
    const receiptCount = (await AppDataSource.query(
      `SELECT count(*)::int AS count FROM command_receipts
       WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3 AND state='completed'`,
      [adminId, `user_import.apply.${jobId}`, key],
    )) as Array<{ count: number }>;
    expect(receiptCount[0]?.count).toBe(1);
    const object = (await AppDataSource.query(
      'SELECT object_key,cleanup_status FROM user_import_jobs WHERE id=$1',
      [jobId],
    )) as Array<{ object_key: string | null; cleanup_status: string }>;
    expect(object[0]).toEqual({ object_key: null, cleanup_status: 'completed' });

    const report = await fetch(
      `${apiBaseUrl}/api/v1/admin/user-imports/${jobId}/report?code=USER_IMPORT_DUPLICATE_EMAIL`,
      { headers: { Cookie: adminJar.header() } },
    );
    expect(report.status).toBe(200);
    const reportText = await report.text();
    expect(reportText).not.toContain(`duplicate-${suffix}@example.gov.vn`);
    const reportBody = JSON.parse(reportText) as Envelope<{ issues: Array<{ code: string }> }>;
    expect(reportBody.data.issues).toHaveLength(2);
    expect(
      reportBody.data.issues.every((issue) => issue.code === 'USER_IMPORT_DUPLICATE_EMAIL'),
    ).toBe(true);

    const thirdReplay = await command(jobId, 'apply', { validRowPolicy: 'invite' }, key);
    expect(thirdReplay.status).toBe(202);
    const replayBody = (await thirdReplay.json()) as Envelope<ImportJob>;
    expect(replayBody.data.status).toBe('completed');
    expect(await identityEffectCount()).toEqual(after);
  });

  it('rejects an all-late-conflict apply atomically after a manual identity wins the lock race', async () => {
    const email = `late-conflict-${suffix}@example.gov.vn`;
    const username = `late.conflict.${suffix}`;
    const content = Buffer.from(
      `email,username,displayName,role\n${email},${username},Late conflict,reviewer`,
    );
    const uploadKey = randomUUID();
    uploadKeys.push(uploadKey);
    const uploaded = await upload(adminJar, content, `late-conflict-${suffix}.csv`, uploadKey);
    expect(uploaded.status).toBe(202);
    const uploadBody = (await uploaded.json()) as Envelope<ImportJob>;
    jobIds.push(uploadBody.data.id);
    await waitForJob(uploadBody.data.id, 'inspected');
    expect((await command(uploadBody.data.id, 'validate', {})).status).toBe(202);
    const ready = await waitForJob(uploadBody.data.id, 'ready');
    expect(ready.counts).toMatchObject({ total: 1, valid: 1, invalid: 0 });

    const manualKey = randomUUID();
    applyKeys.push(manualKey);
    const manual = await fetch(`${apiBaseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(adminJar, adminJar.get('danangmap_csrf')),
        'Idempotency-Key': manualKey,
      },
      body: JSON.stringify({
        email,
        username,
        displayName: 'Manual race winner',
        role: 'reviewer',
        delivery: 'manual',
        temporaryPassword: 'Temporary-Race-Winner-2026!',
      }),
    });
    expect(manual.status).toBe(201);
    const manualBody = (await manual.json()) as Envelope<{ id: string }>;
    importedUserIds.push(manualBody.data.id);

    const before = await identityEffectCount();
    const applyKey = randomUUID();
    applyKeys.push(applyKey);
    expect(
      (await command(uploadBody.data.id, 'apply', { validRowPolicy: 'invite' }, applyKey)).status,
    ).toBe(202);
    const failed = await waitForJob(uploadBody.data.id, 'failed');
    expect(failed.failureCode).toBe('USER_IMPORT_NO_VALID_ROWS_AT_APPLY');
    expect(failed.counts).toEqual({ total: 1, valid: 0, invalid: 1, applied: 0, skipped: 1 });
    expect(await identityEffectCount()).toEqual(before);

    const replay = await command(
      uploadBody.data.id,
      'apply',
      { validRowPolicy: 'invite' },
      applyKey,
    );
    expect(replay.status).toBe(202);
    const replayBody = (await replay.json()) as Envelope<ImportJob>;
    expect(replayBody.data.failureCode).toBe('USER_IMPORT_NO_VALID_ROWS_AT_APPLY');
    expect(await identityEffectCount()).toEqual(before);
  });

  it('hands an imported invite into accept and MFA enrollment without persisting secrets in reports', async () => {
    const editorInvite = (await AppDataSource.query(
      `SELECT i.id FROM invites i JOIN user_import_invites ui ON ui.invite_id=i.id
       WHERE ui.job_id=$1 AND i.role='editor'`,
      [jobIds[0]],
    )) as Array<{ id: string }>;
    const inviteId = editorInvite[0]?.id;
    expect(inviteId).toBeDefined();
    const token = await captureInviteToken(inviteId!);
    const inspect = await fetch(`${apiBaseUrl}/api/v1/auth/invites:inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(inspect.status).toBe(200);

    const publicJar = new CookieJar();
    await rotateCsrf(publicJar);
    const password = 'Imported-Account-Password-2026!';
    const accepted = await fetch(`${apiBaseUrl}/api/v1/auth/invites:accept`, {
      method: 'POST',
      headers: jsonHeaders(publicJar, publicJar.get('danangmap_csrf')),
      body: JSON.stringify({ token, password, passwordConfirmation: password }),
    });
    expect(accepted.status).toBe(200);
    publicJar.absorb(accepted);
    const acceptedBody = (await accepted.json()) as Envelope<{ mfaEnrollmentRequired: boolean }>;
    expect(acceptedBody.data.mfaEnrollmentRequired).toBe(true);
    const users = (await AppDataSource.query('SELECT accepted_user_id FROM invites WHERE id=$1', [
      inviteId,
    ])) as Array<{ accepted_user_id: string }>;
    importedUserIds.push(users[0]!.accepted_user_id);
    const enrollment = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/enroll`, {
      method: 'POST',
      headers: jsonHeaders(publicJar, publicJar.get('danangmap_csrf')),
    });
    expect(enrollment.status).toBe(200);
    const enrollmentBody = (await enrollment.json()) as Envelope<{ enrollmentUri: string }>;
    expect(enrollmentBody.data.enrollmentUri).toMatch(/^otpauth:\/\//);
    const enrollmentSecret = new URL(enrollmentBody.data.enrollmentUri).searchParams.get('secret');
    expect(enrollmentSecret).toBeTruthy();

    const confirmed = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/enroll/confirm`, {
      method: 'POST',
      headers: jsonHeaders(publicJar, publicJar.get('danangmap_csrf')),
      body: JSON.stringify({ code: generateTotp(enrollmentSecret!) }),
    });
    expect(confirmed.status).toBe(200);
    publicJar.absorb(confirmed);
    const confirmedBody = (await confirmed.json()) as Envelope<{
      principal: { id: string; role: string; mfaEnabled: boolean };
      recoveryCodes: string[];
    }>;
    expect(confirmedBody.data.principal).toMatchObject({
      id: importedUserIds.at(-1),
      role: 'editor',
      mfaEnabled: true,
    });
    expect(confirmedBody.data.recoveryCodes).toHaveLength(10);

    const me = await fetch(`${apiBaseUrl}/api/v1/auth/me`, {
      headers: { Cookie: publicJar.header() },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as Envelope<{
      id: string;
      role: string;
      mfaEnabled: boolean;
    }>;
    expect(meBody.data).toMatchObject({
      id: importedUserIds.at(-1),
      role: 'editor',
      mfaEnabled: true,
    });

    const audit = JSON.stringify(
      await AppDataSource.query(
        `SELECT action,metadata FROM audit_logs WHERE occurred_at >= $1
         AND (resource_id=ANY($2::uuid[]) OR metadata->>'jobId'=ANY($3::text[]))`,
        [startedAt, [...inviteIds, ...importedUserIds], jobIds],
      ),
    );
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(password);
    expect(audit).not.toContain(enrollmentSecret!);
    for (const recoveryCode of confirmedBody.data.recoveryCodes) {
      expect(audit).not.toContain(recoveryCode);
    }
  });

  it('rejects XLSX formulas in the worker and removes the quarantined object', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Accounts');
    sheet.addRow(['email', 'username', 'displayName', 'role']);
    sheet.addRow([
      `formula-${suffix}@example.gov.vn`,
      `formula.${suffix}`,
      { formula: '1+1', result: 'Formula' },
      'editor',
    ]);
    const content = Buffer.from(await workbook.xlsx.writeBuffer());
    const key = randomUUID();
    uploadKeys.push(key);
    const response = await upload(adminJar, content, `formula-${suffix}.xlsx`, key);
    expect(response.status).toBe(202);
    const body = (await response.json()) as Envelope<ImportJob>;
    jobIds.push(body.data.id);
    const failed = await waitForJob(body.data.id, 'failed');
    expect(failed.failureCode).toBe('USER_IMPORT_XLSX_FORMULA_FORBIDDEN');
    const stored = (await AppDataSource.query(
      'SELECT object_key,cleanup_status FROM user_import_jobs WHERE id=$1',
      [body.data.id],
    )) as Array<{ object_key: string | null; cleanup_status: string }>;
    expect(stored[0]).toEqual({ object_key: null, cleanup_status: 'completed' });
  });

  async function identityEffectCount(): Promise<{ invites: number; outbox: number }> {
    const [row] = (await AppDataSource.query(
      `SELECT
        (SELECT count(*)::int FROM invites WHERE email LIKE $1) AS invites,
        (SELECT count(*)::int FROM mail_outbox WHERE recipient_email LIKE $1) AS outbox`,
      [`%${suffix}%`],
    )) as Array<{ invites: number; outbox: number }>;
    return row!;
  }

  async function command(
    jobId: string,
    action: 'validate' | 'apply',
    body: Record<string, unknown>,
    key?: string,
  ): Promise<Response> {
    return fetch(`${apiBaseUrl}/api/v1/admin/user-imports/${jobId}:${action}`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(adminJar, adminJar.get('danangmap_csrf')),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function waitForJob(id: string, status: string): Promise<ImportJob> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${apiBaseUrl}/api/v1/admin/user-imports/${id}`, {
        headers: { Cookie: adminJar.header() },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Envelope<ImportJob>;
      if (body.data.status === status) return body.data;
      if (body.data.status === 'failed' && status !== 'failed') {
        throw new Error(`User import ${id} failed: ${body.data.failureCode}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`User import ${id} did not reach ${status}`);
  }
});

async function upload(
  jar: CookieJar,
  content: Buffer,
  name: string,
  idempotencyKey: string,
  csrf: string | undefined = jar.get('danangmap_csrf'),
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(content)]), name);
  return fetch(`${apiBaseUrl}/api/v1/admin/user-imports`, {
    method: 'POST',
    headers: {
      Cookie: jar.header(),
      Origin: allowedOrigin,
      'Idempotency-Key': idempotencyKey,
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: form,
  });
}

async function authenticatedJar(login: string, password: string): Promise<CookieJar> {
  const jar = new CookieJar();
  await rotateCsrf(jar);
  const loginResponse = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: jsonHeaders(jar, jar.get('danangmap_csrf')),
    body: JSON.stringify({ login, password }),
  });
  expect(loginResponse.status).toBe(200);
  jar.absorb(loginResponse);
  const verify = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: jsonHeaders(jar, jar.get('danangmap_csrf')),
    body: JSON.stringify({ method: 'totp', code: generateTotp(mfaSecret) }),
  });
  expect(verify.status).toBe(200);
  jar.absorb(verify);
  return jar;
}

async function rotateCsrf(jar: CookieJar): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: jar.header() ? { Cookie: jar.header() } : undefined,
  });
  expect(response.status).toBe(200);
  jar.absorb(response);
  const body = (await response.json()) as Envelope<{ csrfToken: string }>;
  return body.data.csrfToken;
}

function jsonHeaders(
  jar: CookieJar,
  csrf: string | undefined,
  origin = allowedOrigin,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Cookie: jar.header(),
    Origin: origin,
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  };
}

async function captureInviteToken(inviteId: string): Promise<string> {
  const rows = (await AppDataSource.query(
    'SELECT payload_encrypted FROM mail_outbox WHERE invite_id=$1 ORDER BY created_at DESC LIMIT 1',
    [inviteId],
  )) as Array<{ payload_encrypted: string }>;
  const payload = JSON.parse(decryptField(rows[0]!.payload_encrypted)) as { token?: string };
  if (!payload.token) throw new Error('Imported invite token capture was missing');
  return payload.token;
}

function decryptField(payload: string): string {
  const [nonce, tag, encrypted] = payload.split('.');
  if (!nonce || !tag || !encrypted) throw new Error('Encrypted payload is malformed');
  const key = createHash('sha256')
    .update(
      process.env.FIELD_ENCRYPTION_KEY ?? 'local-only-field-encryption-key-change-in-production',
    )
    .digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function generateTotp(secret: string, offset = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < key.length; index += 1) {
    key[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const counter = Math.floor(Date.now() / 30_000) + offset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const pointer = digest[digest.length - 1]! & 0x0f;
  const value = (digest.readUInt32BE(pointer) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, '0');
}

async function readProblem(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { code?: string };
  expect(body.code).toBe(code);
}
