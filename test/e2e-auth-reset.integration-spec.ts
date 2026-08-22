import { resetE2eSeededAuth } from '../scripts/seed';
import AppDataSource from '../src/database/data-source';

const editorId = '00000000-0000-4000-8000-000000000002';
const editorEmail = 'editor@danangmap.local';

const resetEnvironment = () => ({
  ...process.env,
  NODE_ENV: 'test',
  ALLOW_SEED: 'true',
  SEED_CROSSSTACK_FIXTURES: 'true',
  DANANGMAP_E2E_AUTH_RESET: 'true',
});

describe('E2E auth reset integration', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  it('restores a disabled seeded actor to the pristine verified MFA baseline', async () => {
    await AppDataSource.query(
      `UPDATE users SET status='disabled',disabled_at=now(),must_change_password=true,
         failed_login_count=4,locked_until=now()+interval '10 minutes'
       WHERE id=$1`,
      [editorId],
    );
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=123456 WHERE user_id=$1',
      [editorId],
    );

    await resetE2eSeededAuth(resetEnvironment());

    const [baseline] = (await AppDataSource.query(
      `SELECT u.status,u.disabled_at,u.must_change_password,u.failed_login_count,u.locked_until,
              u.mfa_enabled,m.status AS mfa_status,m.last_used_time_step,m.enrollment_session_id
       FROM users u JOIN user_mfa_methods m ON m.user_id=u.id WHERE u.id=$1`,
      [editorId],
    )) as Array<{
      status: string;
      disabled_at: Date | null;
      must_change_password: boolean;
      failed_login_count: number;
      locked_until: Date | null;
      mfa_enabled: boolean;
      mfa_status: string;
      last_used_time_step: string | null;
      enrollment_session_id: string | null;
    }>;
    expect(baseline).toMatchObject({
      status: 'active',
      disabled_at: null,
      must_change_password: false,
      failed_login_count: 0,
      locked_until: null,
      mfa_enabled: true,
      mfa_status: 'verified',
      last_used_time_step: null,
      enrollment_session_id: null,
    });
  });

  it('refuses an unexpected fixed identity before changing its security state', async () => {
    const unexpectedEmail = 'unexpected-editor@danangmap.local';
    await AppDataSource.query(
      `UPDATE users SET email=$2,email_normalized=lower($2),status='disabled',disabled_at=now()
       WHERE id=$1`,
      [editorId, unexpectedEmail],
    );
    await AppDataSource.query(
      'UPDATE user_mfa_methods SET last_used_time_step=654321 WHERE user_id=$1',
      [editorId],
    );

    try {
      await expect(resetE2eSeededAuth(resetEnvironment())).rejects.toThrow(
        /unexpected seeded actor identity set/u,
      );
      const [unchanged] = (await AppDataSource.query(
        `SELECT u.email,u.status,u.disabled_at,m.last_used_time_step
         FROM users u JOIN user_mfa_methods m ON m.user_id=u.id WHERE u.id=$1`,
        [editorId],
      )) as Array<{
        email: string;
        status: string;
        disabled_at: Date | null;
        last_used_time_step: string | null;
      }>;
      expect(unchanged).toMatchObject({
        email: unexpectedEmail,
        status: 'disabled',
        last_used_time_step: '654321',
      });
      if (!unchanged) throw new Error('Seeded Editor disappeared during rejected reset');
      expect(unchanged.disabled_at).not.toBeNull();
    } finally {
      await AppDataSource.query(
        'UPDATE users SET email=$2,email_normalized=lower($2) WHERE id=$1',
        [editorId, editorEmail],
      );
      await resetE2eSeededAuth(resetEnvironment());
    }
  });
});
