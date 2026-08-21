import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MfaEnrollmentRecovery1761000004000 implements MigrationInterface {
  name = 'MfaEnrollmentRecovery1761000004000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user_mfa_methods (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified')),
        secret_encrypted text NOT NULL,
        last_used_time_step bigint,
        enrollment_session_id uuid REFERENCES admin_sessions(id) ON DELETE CASCADE,
        verified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_user_mfa_methods_user_totp UNIQUE (user_id),
        CONSTRAINT ck_user_mfa_method_verified_at CHECK (
          (status = 'pending' AND verified_at IS NULL AND enrollment_session_id IS NOT NULL)
          OR (status = 'verified' AND verified_at IS NOT NULL AND enrollment_session_id IS NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_user_mfa_methods_enrollment_session
       ON user_mfa_methods(enrollment_session_id)`,
    );
    await queryRunner.query(`
      CREATE TABLE user_mfa_recovery_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_digest text NOT NULL,
        consumed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_user_mfa_recovery_code_digest UNIQUE (code_digest)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_user_mfa_recovery_codes_active
       ON user_mfa_recovery_codes(user_id, consumed_at)`,
    );
    await queryRunner.query(`
      INSERT INTO user_mfa_methods(user_id,status,secret_encrypted,verified_at)
      SELECT id,'verified',mfa_secret_encrypted,now()
      FROM users
      WHERE mfa_enabled=true AND mfa_secret_encrypted IS NOT NULL
      ON CONFLICT(user_id) DO NOTHING
    `);
    await queryRunner.query(`
      ALTER TABLE admin_sessions
        ADD COLUMN mfa_failed_attempts integer NOT NULL DEFAULT 0
          CHECK (mfa_failed_attempts >= 0),
        ADD COLUMN mfa_locked_until timestamptz
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE admin_sessions DROP COLUMN mfa_locked_until');
    await queryRunner.query('ALTER TABLE admin_sessions DROP COLUMN mfa_failed_attempts');
    await queryRunner.query('DROP TABLE user_mfa_recovery_codes');
    await queryRunner.query('DROP TABLE user_mfa_methods');
  }
}
