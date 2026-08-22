import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UserImportLifecycle1761000007000 implements MigrationInterface {
  name = 'UserImportLifecycle1761000007000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user_import_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id uuid NOT NULL REFERENCES users(id),
        object_key text,
        file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 180),
        file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[a-f0-9]{64}$'),
        size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
        format text NOT NULL CHECK (format IN ('csv','xlsx')),
        status text NOT NULL DEFAULT 'uploaded' CHECK (
          status IN ('uploaded','inspecting','inspected','validating','ready','applying','completed','failed')
        ),
        progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        counts jsonb NOT NULL DEFAULT '{"total":0,"valid":0,"invalid":0,"applied":0,"skipped":0}'::jsonb,
        sheets text[] NOT NULL DEFAULT '{}'::text[],
        selected_sheet text,
        validation_version integer NOT NULL DEFAULT 0 CHECK (validation_version >= 0),
        idempotency_key uuid NOT NULL,
        upload_request_digest text NOT NULL CHECK (upload_request_digest ~ '^[a-f0-9]{64}$'),
        apply_context jsonb,
        failure_code text,
        cleanup_status text NOT NULL DEFAULT 'pending' CHECK (cleanup_status IN ('pending','completed')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_user_import_jobs_actor_idempotency UNIQUE(actor_id,idempotency_key),
        CONSTRAINT ck_user_import_object_lifecycle CHECK (
          object_key IS NOT NULL OR cleanup_status='completed'
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_user_import_jobs_actor_created ON user_import_jobs(actor_id,created_at DESC)',
    );
    await queryRunner.query(`
      CREATE TABLE user_import_rows (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES user_import_jobs(id) ON DELETE CASCADE,
        row_number integer NOT NULL CHECK (row_number >= 2),
        email text NOT NULL,
        email_normalized text NOT NULL,
        username text NOT NULL,
        username_normalized text NOT NULL,
        display_name text NOT NULL,
        role text CHECK (role IN ('system_admin','editor','reviewer','publisher')),
        valid boolean NOT NULL,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        CONSTRAINT uq_user_import_rows_job_row UNIQUE(job_id,row_number)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_user_import_rows_job_valid ON user_import_rows(job_id,valid,row_number)',
    );
    await queryRunner.query(`
      CREATE TABLE user_import_issues (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES user_import_jobs(id) ON DELETE CASCADE,
        row_number integer NOT NULL CHECK (row_number >= 1),
        severity text NOT NULL DEFAULT 'error' CHECK (severity='error'),
        code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
        field text CHECK (field IN ('file','email','username','displayName','role'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_user_import_issues_job_cursor ON user_import_issues(job_id,id)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_user_import_issues_job_filter ON user_import_issues(job_id,severity,code,id)',
    );
    await queryRunner.query(`
      CREATE TABLE user_import_invites (
        invite_id uuid PRIMARY KEY REFERENCES invites(id) ON DELETE CASCADE,
        job_id uuid NOT NULL REFERENCES user_import_jobs(id) ON DELETE CASCADE,
        row_number integer NOT NULL CHECK (row_number >= 2),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_user_import_invites_job_row UNIQUE(job_id,row_number)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE user_import_invites');
    await queryRunner.query('DROP TABLE user_import_issues');
    await queryRunner.query('DROP TABLE user_import_rows');
    await queryRunner.query('DROP TABLE user_import_jobs');
  }
}
