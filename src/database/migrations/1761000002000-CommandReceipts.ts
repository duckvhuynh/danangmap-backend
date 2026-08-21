import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CommandReceipts1761000002000 implements MigrationInterface {
  name = 'CommandReceipts1761000002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE command_receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id uuid NOT NULL REFERENCES users(id),
        operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.-]{2,99}$'),
        idempotency_key uuid NOT NULL,
        request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
        state text NOT NULL CHECK (state IN ('pending','completed')),
        status_code integer CHECK (status_code BETWEEN 200 AND 299),
        response_payload jsonb,
        response_etag text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_command_receipt UNIQUE(actor_id,operation,idempotency_key),
        CONSTRAINT ck_command_receipt_completion CHECK (
          (state='pending') OR (status_code IS NOT NULL AND response_payload IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_command_receipts_created ON command_receipts(created_at)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE command_receipts');
  }
}
