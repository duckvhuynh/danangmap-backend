import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MailDeliveryOutbox1761000008000 implements MigrationInterface {
  name = 'MailDeliveryOutbox1761000008000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_mail_outbox_ready');
    await queryRunner.query(
      'ALTER TABLE mail_outbox DROP CONSTRAINT IF EXISTS mail_outbox_status_check',
    );
    await queryRunner.query(`
      ALTER TABLE mail_outbox
        ALTER COLUMN payload_encrypted DROP NOT NULL,
        ADD COLUMN claim_token uuid,
        ADD COLUMN claimed_at timestamptz,
        ADD COLUMN lease_expires_at timestamptz,
        ADD COLUMN last_attempt_at timestamptz,
        ADD COLUMN sent_at timestamptz,
        ADD COLUMN failed_at timestamptz,
        ADD COLUMN dead_at timestamptz,
        ADD COLUMN payload_scrubbed_at timestamptz,
        ADD COLUMN provider_message_id text,
        ADD COLUMN last_error_code text,
        ADD COLUMN last_smtp_status integer
    `);
    await queryRunner.query(`
      UPDATE mail_outbox
      SET status='pending', next_attempt_at=COALESCE(next_attempt_at,now()), updated_at=now()
      WHERE status='sending'
    `);
    await queryRunner.query(`
      UPDATE mail_outbox
      SET status='cancelled', payload_encrypted=NULL, next_attempt_at=NULL,
          payload_scrubbed_at=now(), last_error_code='MAIL_LEGACY_CANCELLED', updated_at=now()
      WHERE status='failed'
    `);
    await queryRunner.query(`
      UPDATE mail_outbox
      SET payload_encrypted=NULL, next_attempt_at=NULL, sent_at=COALESCE(updated_at,created_at),
          payload_scrubbed_at=COALESCE(updated_at,created_at), updated_at=now()
      WHERE status='sent'
    `);
    await queryRunner.query(`
      ALTER TABLE mail_outbox
        ADD CONSTRAINT ck_mail_outbox_status CHECK (
          status IN ('pending','claimed','sending','sent','failed','cancelled','dead')
        ),
        ADD CONSTRAINT ck_mail_outbox_attempts CHECK (attempts BETWEEN 0 AND 100),
        ADD CONSTRAINT ck_mail_outbox_claim CHECK (
          (status IN ('claimed','sending') AND claim_token IS NOT NULL
            AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
          OR
          (status NOT IN ('claimed','sending') AND claim_token IS NULL
            AND claimed_at IS NULL AND lease_expires_at IS NULL)
        ),
        ADD CONSTRAINT ck_mail_outbox_terminal_scrub CHECK (
          status NOT IN ('sent','cancelled','dead')
          OR (payload_encrypted IS NULL AND payload_scrubbed_at IS NOT NULL)
        ),
        ADD CONSTRAINT ck_mail_outbox_delivery_time CHECK (
          (status='sent' AND sent_at IS NOT NULL) OR (status<>'sent' AND sent_at IS NULL)
        ),
        ADD CONSTRAINT ck_mail_outbox_dead_time CHECK (
          (status='dead' AND dead_at IS NOT NULL) OR (status<>'dead' AND dead_at IS NULL)
        ),
        ADD CONSTRAINT ck_mail_outbox_smtp_status CHECK (
          last_smtp_status IS NULL OR last_smtp_status BETWEEN 200 AND 599
        )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mail_outbox_due
      ON mail_outbox(next_attempt_at,id)
      WHERE status='pending'
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mail_outbox_failed_retention
      ON mail_outbox(failed_at,id)
      WHERE status='failed'
    `);
    await queryRunner.query(`
      CREATE INDEX idx_mail_outbox_lease
      ON mail_outbox(lease_expires_at,id)
      WHERE status IN ('claimed','sending')
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_mail_outbox_recipient_inflight
      ON mail_outbox(lower(recipient_email))
      WHERE status IN ('claimed','sending')
    `);

    await queryRunner.query(`
      CREATE TABLE mail_delivery_state (
        id smallint PRIMARY KEY DEFAULT 1 CHECK (id=1),
        status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','up','degraded')),
        worker_heartbeat_at timestamptz,
        last_smtp_check_at timestamptz,
        last_success_at timestamptz,
        last_error_code text,
        queue_depth integer NOT NULL DEFAULT 0 CHECK (queue_depth >= 0),
        oldest_age_seconds integer NOT NULL DEFAULT 0 CHECK (oldest_age_seconds >= 0),
        sent_count bigint NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
        failed_count bigint NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
        retry_count bigint NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query("INSERT INTO mail_delivery_state(id,status) VALUES(1,'disabled')");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE mail_delivery_state');
    await queryRunner.query('DROP INDEX uq_mail_outbox_recipient_inflight');
    await queryRunner.query('DROP INDEX idx_mail_outbox_lease');
    await queryRunner.query('DROP INDEX idx_mail_outbox_failed_retention');
    await queryRunner.query('DROP INDEX idx_mail_outbox_due');
    await queryRunner.query(`
      ALTER TABLE mail_outbox
        DROP CONSTRAINT ck_mail_outbox_smtp_status,
        DROP CONSTRAINT ck_mail_outbox_dead_time,
        DROP CONSTRAINT ck_mail_outbox_delivery_time,
        DROP CONSTRAINT ck_mail_outbox_terminal_scrub,
        DROP CONSTRAINT ck_mail_outbox_claim,
        DROP CONSTRAINT ck_mail_outbox_attempts,
        DROP CONSTRAINT ck_mail_outbox_status
    `);
    await queryRunner.query(`
      UPDATE mail_outbox
      SET status=CASE
          WHEN status='sent' THEN 'sent'
          WHEN status IN ('pending','claimed','sending') THEN 'pending'
          ELSE 'failed'
        END,
        payload_encrypted=COALESCE(payload_encrypted,'scrubbed')
    `);
    await queryRunner.query(`
      ALTER TABLE mail_outbox
        DROP COLUMN last_smtp_status,
        DROP COLUMN last_error_code,
        DROP COLUMN provider_message_id,
        DROP COLUMN payload_scrubbed_at,
        DROP COLUMN dead_at,
        DROP COLUMN failed_at,
        DROP COLUMN sent_at,
        DROP COLUMN last_attempt_at,
        DROP COLUMN lease_expires_at,
        DROP COLUMN claimed_at,
        DROP COLUMN claim_token,
        ALTER COLUMN payload_encrypted SET NOT NULL,
        ADD CONSTRAINT mail_outbox_status_check CHECK (status IN ('pending','sending','sent','failed'))
    `);
    await queryRunner.query(
      'CREATE INDEX idx_mail_outbox_ready ON mail_outbox(status,next_attempt_at)',
    );
  }
}
