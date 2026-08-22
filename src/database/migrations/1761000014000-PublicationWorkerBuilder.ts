import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PublicationWorkerBuilder1761000014000 implements MigrationInterface {
  name = 'PublicationWorkerBuilder1761000014000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE publication_job_batches
      ADD COLUMN public_projection jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD CONSTRAINT ck_publication_batch_projection CHECK (
        jsonb_typeof(public_projection)='array'
        AND jsonb_array_length(public_projection)=feature_count
        AND pg_column_size(public_projection) <= 16777216
      )
    `);
    await queryRunner.query(
      `ALTER TABLE publication_job_batches ALTER COLUMN public_projection DROP DEFAULT`,
    );

    await queryRunner.query(`
      ALTER TABLE publication_jobs
      ADD CONSTRAINT ck_publication_job_worker_lease CHECK (
        (status='building' AND lease_token IS NOT NULL)
        OR (status<>'building' AND lease_token IS NULL)
      )
    `);

    await queryRunner.query(`
      ALTER TABLE publication_worker_state
      ADD COLUMN last_recovery_sweep_at timestamptz,
      ADD COLUMN reconciliation_cursor_available_at timestamptz,
      ADD COLUMN dispatch_error_code text,
      ADD COLUMN worker_error_code text,
      ADD COLUMN recovered_lease_count bigint NOT NULL DEFAULT 0
        CHECK (recovered_lease_count >= 0),
      ADD COLUMN completed_job_count bigint NOT NULL DEFAULT 0
        CHECK (completed_job_count >= 0),
      ADD COLUMN failed_job_count bigint NOT NULL DEFAULT 0
        CHECK (failed_job_count >= 0)
    `);
    await queryRunner.query(`
      UPDATE publication_worker_state
      SET reconciliation_cursor_created_at=NULL,
          reconciliation_cursor_job_id=NULL,
          dispatch_error_code=last_error_code,
          worker_error_code=last_error_code
    `);
    await queryRunner.query(`
      ALTER TABLE publication_worker_state
      DROP CONSTRAINT ck_publication_worker_reconciliation_cursor,
      ADD CONSTRAINT ck_publication_worker_reconciliation_cursor CHECK (
        (reconciliation_cursor_available_at IS NULL
          AND reconciliation_cursor_created_at IS NULL
          AND reconciliation_cursor_job_id IS NULL)
        OR (reconciliation_cursor_available_at IS NOT NULL
          AND reconciliation_cursor_created_at IS NOT NULL
          AND reconciliation_cursor_job_id IS NOT NULL)
      ),
      ADD CONSTRAINT ck_publication_worker_dispatch_error CHECK (
        dispatch_error_code IS NULL OR dispatch_error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
      ),
      ADD CONSTRAINT ck_publication_worker_worker_error CHECK (
        worker_error_code IS NULL OR worker_error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'
      )
    `);
    await queryRunner.query(`DROP INDEX idx_publication_job_reconciliation`);
    await queryRunner.query(`
      CREATE INDEX idx_publication_job_reconciliation_available
      ON publication_jobs(available_at,created_at,id) WHERE status='queued'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX idx_publication_job_reconciliation_available`);
    await queryRunner.query(`
      CREATE INDEX idx_publication_job_reconciliation
      ON publication_jobs(created_at,id) WHERE status='queued'
    `);
    await queryRunner.query(`
      ALTER TABLE publication_worker_state
      DROP CONSTRAINT ck_publication_worker_worker_error,
      DROP CONSTRAINT ck_publication_worker_dispatch_error,
      DROP CONSTRAINT ck_publication_worker_reconciliation_cursor,
      DROP COLUMN failed_job_count,
      DROP COLUMN completed_job_count,
      DROP COLUMN recovered_lease_count,
      DROP COLUMN worker_error_code,
      DROP COLUMN dispatch_error_code,
      DROP COLUMN reconciliation_cursor_available_at,
      DROP COLUMN last_recovery_sweep_at
    `);
    await queryRunner.query(`
      ALTER TABLE publication_worker_state
      ADD CONSTRAINT ck_publication_worker_reconciliation_cursor CHECK (
        (reconciliation_cursor_created_at IS NULL AND reconciliation_cursor_job_id IS NULL)
        OR (reconciliation_cursor_created_at IS NOT NULL
          AND reconciliation_cursor_job_id IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `ALTER TABLE publication_jobs DROP CONSTRAINT ck_publication_job_worker_lease`,
    );
    await queryRunner.query(`
      ALTER TABLE publication_job_batches
      DROP CONSTRAINT ck_publication_batch_projection,
      DROP COLUMN public_projection
    `);
  }
}
