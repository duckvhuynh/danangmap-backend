import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PasswordResetSessionSecurity1761000006000 implements MigrationInterface {
  name = 'PasswordResetSessionSecurity1761000006000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE password_reset_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        revoked_at timestamptz,
        ip_hash text,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_password_reset_tokens_token_hash UNIQUE (token_hash),
        CONSTRAINT ck_password_reset_token_terminal_state CHECK (
          used_at IS NULL OR revoked_at IS NULL
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_password_reset_tokens_user_active
      ON password_reset_tokens(user_id)
      WHERE used_at IS NULL AND revoked_at IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE mail_outbox
        ADD COLUMN password_reset_token_id uuid,
        ADD CONSTRAINT fk_mail_outbox_password_reset_token
          FOREIGN KEY (password_reset_token_id)
          REFERENCES password_reset_tokens(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mail_outbox_password_reset_token
      ON mail_outbox(password_reset_token_id)
      WHERE password_reset_token_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE public_command_receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.-]{2,99}$'),
        idempotency_key uuid NOT NULL,
        request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
        state text NOT NULL CHECK (state IN ('pending','completed')),
        status_code integer CHECK (status_code BETWEEN 200 AND 299),
        response_payload jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_public_command_receipt UNIQUE(operation,idempotency_key),
        CONSTRAINT ck_public_command_receipt_completion CHECK (
          state='pending' OR (status_code IS NOT NULL AND response_payload IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_public_command_receipts_created ON public_command_receipts(created_at)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public_command_receipts');
    await queryRunner.query('DROP INDEX idx_mail_outbox_password_reset_token');
    await queryRunner.query(
      'ALTER TABLE mail_outbox DROP CONSTRAINT fk_mail_outbox_password_reset_token',
    );
    await queryRunner.query('ALTER TABLE mail_outbox DROP COLUMN password_reset_token_id');
    await queryRunner.query('DROP TABLE password_reset_tokens');
  }
}
