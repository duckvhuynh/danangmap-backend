import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DurablePublicationJobs1761000013000 implements MigrationInterface {
  name = 'DurablePublicationJobs1761000013000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE command_receipts
      ADD COLUMN response_metadata jsonb,
      ADD CONSTRAINT ck_command_receipt_response_metadata CHECK (
        response_metadata IS NULL OR (
          jsonb_typeof(response_metadata)='object'
          AND pg_column_size(response_metadata) <= 4096
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE publication_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        layer_id uuid NOT NULL REFERENCES layers(id),
        revision_id uuid NOT NULL REFERENCES layer_revisions(id),
        requested_by uuid NOT NULL REFERENCES users(id),
        request_id uuid NOT NULL,
        client_intent text NOT NULL CHECK (client_intent='desktop'),
        release_note text NOT NULL CHECK (char_length(release_note) BETWEEN 1 AND 4000),
        expected_active_snapshot_id uuid REFERENCES publication_snapshots(id),
        expected_active_generation bigint CHECK (expected_active_generation IS NULL OR expected_active_generation > 0),
        revision_lock_version integer NOT NULL CHECK (revision_lock_version > 0),
        revision_schema_version integer NOT NULL CHECK (revision_schema_version > 0),
        revision_fingerprint text NOT NULL CHECK (revision_fingerprint ~ '^[a-f0-9]{64}$'),
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','building','succeeded','failed')),
        phase text NOT NULL DEFAULT 'queued' CHECK (phase IN ('queued','preparing','scanning_features','switching','completed','failed')),
        lock_version integer NOT NULL DEFAULT 1 CHECK (lock_version > 0),
        feature_total integer CHECK (feature_total IS NULL OR feature_total >= 0),
        feature_processed integer NOT NULL DEFAULT 0 CHECK (feature_processed >= 0),
        vertex_processed bigint NOT NULL DEFAULT 0 CHECK (vertex_processed >= 0),
        build_feature_count integer CHECK (build_feature_count IS NULL OR build_feature_count >= 0),
        build_bounds double precision[],
        build_checksum text,
        build_manifest jsonb,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
        available_at timestamptz NOT NULL DEFAULT now(),
        lease_token uuid,
        lease_owner text,
        lease_expires_at timestamptz,
        heartbeat_at timestamptz,
        result_snapshot_id uuid UNIQUE REFERENCES publication_snapshots(id),
        failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
        failure_correlation_id uuid,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_publication_job_progress CHECK (
          feature_total IS NULL OR feature_processed <= feature_total
        ),
        CONSTRAINT ck_publication_job_build_bounds CHECK (
          build_bounds IS NULL OR cardinality(build_bounds)=4
        ),
        CONSTRAINT ck_publication_job_lease CHECK (
          (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
          OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        ),
        CONSTRAINT ck_publication_job_state CHECK (
          (status='queued' AND phase='queued' AND result_snapshot_id IS NULL
            AND failure_code IS NULL AND failure_correlation_id IS NULL AND finished_at IS NULL)
          OR (status='building' AND phase IN ('preparing','scanning_features','switching')
            AND started_at IS NOT NULL AND result_snapshot_id IS NULL
            AND failure_code IS NULL AND failure_correlation_id IS NULL AND finished_at IS NULL)
          OR (status='succeeded' AND phase='completed' AND result_snapshot_id IS NOT NULL
            AND failure_code IS NULL AND failure_correlation_id IS NULL AND finished_at IS NOT NULL)
          OR (status='failed' AND phase='failed' AND result_snapshot_id IS NULL
            AND failure_code IS NOT NULL AND failure_correlation_id IS NOT NULL AND finished_at IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_publication_job_active_layer
       ON publication_jobs(layer_id) WHERE status IN ('queued','building')`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_publication_job_dispatch
       ON publication_jobs(status,available_at,id) WHERE status='queued'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_publication_job_lease
       ON publication_jobs(lease_expires_at,id) WHERE status='building'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_publication_job_reconciliation
       ON publication_jobs(created_at,id) WHERE status='queued'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_publication_job_layer_cursor
       ON publication_jobs(layer_id,created_at DESC,id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_publication_job_revision_cursor
       ON publication_jobs(revision_id,created_at DESC,id DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE publication_job_batches (
        job_id uuid NOT NULL REFERENCES publication_jobs(id) ON DELETE CASCADE,
        batch_no integer NOT NULL CHECK (batch_no > 0),
        first_feature_id uuid NOT NULL,
        last_feature_id uuid NOT NULL,
        feature_count integer NOT NULL CHECK (feature_count > 0),
        vertex_count bigint NOT NULL CHECK (vertex_count >= 0),
        bounds double precision[],
        public_checksum text NOT NULL CHECK (public_checksum ~ '^[a-f0-9]{64}$'),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(job_id,batch_no),
        CONSTRAINT uq_publication_job_batch_cursor UNIQUE(job_id,last_feature_id),
        CONSTRAINT ck_publication_job_batch_bounds CHECK (
          bounds IS NULL OR cardinality(bounds)=4
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE publication_job_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        publication_job_id uuid NOT NULL UNIQUE REFERENCES publication_jobs(id) ON DELETE CASCADE,
        payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version=1),
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatching','dispatched')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at timestamptz NOT NULL DEFAULT now(),
        lease_token uuid,
        lease_owner text,
        lease_expires_at timestamptz,
        dispatched_at timestamptz,
        last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_publication_outbox_lease CHECK (
          (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
          OR (status='dispatching' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL)
        ),
        CONSTRAINT ck_publication_outbox_state CHECK (
          (status IN ('pending','dispatching') AND dispatched_at IS NULL)
          OR (status='dispatched' AND dispatched_at IS NOT NULL
            AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_publication_outbox_dispatch
       ON publication_job_outbox(status,available_at,id)
       WHERE status IN ('pending','dispatching')`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_publication_outbox_lease
       ON publication_job_outbox(lease_expires_at,id) WHERE status='dispatching'`,
    );

    await queryRunner.query(`
      CREATE TABLE publication_worker_state (
        id smallint PRIMARY KEY CHECK (id=1),
        worker_heartbeat_at timestamptz,
        last_dispatch_sweep_at timestamptz,
        queue_depth integer NOT NULL DEFAULT 0 CHECK (queue_depth >= 0),
        oldest_queued_age_seconds integer NOT NULL DEFAULT 0 CHECK (oldest_queued_age_seconds >= 0),
        building_count integer NOT NULL DEFAULT 0 CHECK (building_count >= 0),
        last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
        reconciliation_cursor_created_at timestamptz,
        reconciliation_cursor_job_id uuid,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_publication_worker_reconciliation_cursor CHECK (
          (reconciliation_cursor_created_at IS NULL AND reconciliation_cursor_job_id IS NULL)
          OR (reconciliation_cursor_created_at IS NOT NULL AND reconciliation_cursor_job_id IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`INSERT INTO publication_worker_state(id) VALUES(1)`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION danangmap_validate_publication_job_transition()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        old_phase_rank integer;
        new_phase_rank integer;
      BEGIN
        IF OLD.status IN ('succeeded','failed') THEN
          RAISE EXCEPTION 'terminal publication jobs are immutable';
        END IF;
        IF NEW.layer_id IS DISTINCT FROM OLD.layer_id
          OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
          OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
          OR NEW.request_id IS DISTINCT FROM OLD.request_id
          OR NEW.client_intent IS DISTINCT FROM OLD.client_intent
          OR NEW.release_note IS DISTINCT FROM OLD.release_note
          OR NEW.expected_active_snapshot_id IS DISTINCT FROM OLD.expected_active_snapshot_id
          OR NEW.expected_active_generation IS DISTINCT FROM OLD.expected_active_generation
          OR NEW.revision_lock_version IS DISTINCT FROM OLD.revision_lock_version
          OR NEW.revision_schema_version IS DISTINCT FROM OLD.revision_schema_version
          OR NEW.revision_fingerprint IS DISTINCT FROM OLD.revision_fingerprint
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'publication job identity is immutable';
        END IF;
        IF NEW.lock_version <> OLD.lock_version + 1 THEN
          RAISE EXCEPTION 'publication job lock_version must increment exactly once';
        END IF;
        IF NEW.feature_processed < OLD.feature_processed
          OR NEW.vertex_processed < OLD.vertex_processed
          OR NEW.attempts < OLD.attempts THEN
          RAISE EXCEPTION 'publication job progress cannot regress';
        END IF;
        IF OLD.feature_total IS NOT NULL
          AND NEW.feature_total IS DISTINCT FROM OLD.feature_total THEN
          RAISE EXCEPTION 'publication job feature_total is immutable once measured';
        END IF;
        IF NOT (
          (OLD.status='queued' AND NEW.status IN ('queued','building','failed'))
          OR (OLD.status='building' AND NEW.status IN ('queued','building','succeeded','failed'))
        ) THEN
          RAISE EXCEPTION 'invalid publication job status transition';
        END IF;
        old_phase_rank := CASE OLD.phase
          WHEN 'preparing' THEN 1 WHEN 'scanning_features' THEN 2
          WHEN 'switching' THEN 3 ELSE 0 END;
        new_phase_rank := CASE NEW.phase
          WHEN 'preparing' THEN 1 WHEN 'scanning_features' THEN 2
          WHEN 'switching' THEN 3 ELSE 0 END;
        IF OLD.status='building' AND NEW.status='building' AND new_phase_rank < old_phase_rank THEN
          RAISE EXCEPTION 'publication job phase cannot regress';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_publication_jobs_transition
      BEFORE UPDATE ON publication_jobs
      FOR EACH ROW EXECUTE FUNCTION danangmap_validate_publication_job_transition()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION danangmap_validate_publication_outbox_transition()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.publication_job_id IS DISTINCT FROM OLD.publication_job_id
          OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'publication outbox identity is immutable';
        END IF;
        IF NEW.attempts < OLD.attempts THEN
          RAISE EXCEPTION 'publication outbox attempts cannot regress';
        END IF;
        IF OLD.status='dispatched' AND NEW.status <> 'dispatched' THEN
          RAISE EXCEPTION 'dispatched publication outbox rows cannot be reopened';
        END IF;
        IF NOT (
          (OLD.status='pending' AND NEW.status IN ('pending','dispatching'))
          OR (OLD.status='dispatching' AND NEW.status IN ('pending','dispatching','dispatched'))
          OR (OLD.status='dispatched' AND NEW.status='dispatched')
        ) THEN
          RAISE EXCEPTION 'invalid publication outbox status transition';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_publication_job_outbox_transition
      BEFORE UPDATE ON publication_job_outbox
      FOR EACH ROW EXECUTE FUNCTION danangmap_validate_publication_outbox_transition()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_publication_job_outbox_transition ON publication_job_outbox`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS danangmap_validate_publication_outbox_transition`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_publication_jobs_transition ON publication_jobs`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS danangmap_validate_publication_job_transition`,
    );
    await queryRunner.query(`DROP TABLE publication_worker_state`);
    await queryRunner.query(`DROP TABLE publication_job_outbox`);
    await queryRunner.query(`DROP TABLE publication_job_batches`);
    await queryRunner.query(`DROP TABLE publication_jobs`);
    await queryRunner.query(
      `ALTER TABLE command_receipts DROP CONSTRAINT ck_command_receipt_response_metadata,
       DROP COLUMN response_metadata`,
    );
  }
}
