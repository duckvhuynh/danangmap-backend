import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSpatialCms1761000000000 implements MigrationInterface {
  name = 'InitialSpatialCms1761000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS unaccent');

    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        email_normalized text NOT NULL,
        username text NOT NULL,
        username_normalized text NOT NULL,
        display_name text NOT NULL,
        role text NOT NULL CHECK (role IN ('system_admin','editor','reviewer','publisher')),
        status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('active','inactive','disabled','invited')),
        password_hash text,
        must_change_password boolean NOT NULL DEFAULT false,
        mfa_enabled boolean NOT NULL DEFAULT false,
        mfa_secret_encrypted text,
        failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
        locked_until timestamptz,
        disabled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_users_active_password CHECK (status <> 'active' OR password_hash IS NOT NULL)
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_users_email_normalized ON users(email_normalized)',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_users_username_normalized ON users(username_normalized)',
    );

    await queryRunner.query(`
      CREATE TABLE admin_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        csrf_hash text,
        kind text NOT NULL CHECK (kind IN ('preauth','authenticated')),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        ip_hash text,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_authenticated_csrf CHECK (kind <> 'authenticated' OR csrf_hash IS NOT NULL)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_admin_sessions_user_active ON admin_sessions(user_id, expires_at) WHERE revoked_at IS NULL',
    );

    await queryRunner.query(`
      CREATE TABLE invites (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        username text NOT NULL,
        display_name text NOT NULL,
        role text NOT NULL CHECK (role IN ('system_admin','editor','reviewer','publisher')),
        token_hash text NOT NULL UNIQUE,
        created_by uuid NOT NULL REFERENCES users(id),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE mail_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        template_key text NOT NULL,
        recipient_email text NOT NULL,
        payload_encrypted text NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        correlation_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_mail_outbox_ready ON mail_outbox(status, next_attempt_at)',
    );

    await queryRunner.query(`
      CREATE TABLE layer_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
        description text,
        display_order integer NOT NULL DEFAULT 0,
        default_visible boolean NOT NULL DEFAULT true,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_layer_groups_slug_active ON layer_groups(slug) WHERE archived_at IS NULL',
    );

    await queryRunner.query(`
      CREATE TABLE layers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
        group_id uuid REFERENCES layer_groups(id) ON DELETE SET NULL,
        display_order integer NOT NULL DEFAULT 0,
        created_by uuid NOT NULL REFERENCES users(id),
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_layers_slug_active ON layers(slug) WHERE archived_at IS NULL',
    );
    await queryRunner.query(
      'CREATE INDEX idx_layers_catalog ON layers(group_id, display_order) WHERE archived_at IS NULL',
    );

    await queryRunner.query(`
      CREATE TABLE layer_revisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        layer_id uuid NOT NULL REFERENCES layers(id),
        revision_no integer NOT NULL CHECK (revision_no > 0),
        status text NOT NULL CHECK (status IN ('draft','in_review','changes_requested','approved','publishing','published')),
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
        description text,
        geometry_mode text NOT NULL CHECK (geometry_mode IN ('point','circle','polyline','polygon','mixed')),
        allowed_geometry_kinds text[] NOT NULL,
        style jsonb NOT NULL DEFAULT '{}'::jsonb,
        render_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        popup_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
        lock_version integer NOT NULL DEFAULT 1 CHECK (lock_version > 0),
        cursor_seq bigint NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
        created_by uuid NOT NULL REFERENCES users(id),
        supersedes_revision_id uuid REFERENCES layer_revisions(id),
        submitted_at timestamptz,
        approved_at timestamptz,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_layer_revision_number UNIQUE (layer_id, revision_no),
        CONSTRAINT ck_mixed_geometry_allowlist CHECK (
          cardinality(allowed_geometry_kinds) > 0
          AND allowed_geometry_kinds <@ ARRAY['point','multipoint','line','multiline','polygon','multipolygon','circle']::text[]
        )
      )
    `);
    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_layer_active_draft ON layer_revisions(layer_id) WHERE status = 'draft'",
    );
    await queryRunner.query(
      'CREATE INDEX idx_layer_revisions_status ON layer_revisions(layer_id, status, revision_no DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE layer_fields (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        revision_id uuid NOT NULL REFERENCES layer_revisions(id) ON DELETE CASCADE,
        key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
        label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
        description text,
        type text NOT NULL CHECK (type IN ('text','long_text','number','integer','boolean','date','datetime','url','email','phone','enum','multi_enum','address','image','attachment')),
        icon text,
        required boolean NOT NULL DEFAULT false,
        public boolean NOT NULL DEFAULT true,
        searchable boolean NOT NULL DEFAULT false,
        filterable boolean NOT NULL DEFAULT false,
        sortable boolean NOT NULL DEFAULT false,
        sensitive boolean NOT NULL DEFAULT false,
        offline_cache boolean NOT NULL DEFAULT true,
        default_value jsonb,
        validation jsonb NOT NULL DEFAULT '{}'::jsonb,
        options jsonb NOT NULL DEFAULT '[]'::jsonb,
        display_order integer NOT NULL DEFAULT 0,
        CONSTRAINT uq_layer_fields_key UNIQUE (revision_id, key),
        CONSTRAINT ck_sensitive_offline_cache CHECK (NOT sensitive OR NOT offline_cache)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE features (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        layer_id uuid NOT NULL REFERENCES layers(id),
        external_source text,
        external_id text,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_external_identity_pair CHECK ((external_source IS NULL) = (external_id IS NULL))
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_features_external_identity ON features(layer_id, external_source, external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL AND deleted_at IS NULL',
    );

    await queryRunner.query(`
      CREATE TABLE feature_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        feature_id uuid NOT NULL REFERENCES features(id),
        revision_id uuid NOT NULL REFERENCES layer_revisions(id),
        geometry geometry(Geometry,4326) NOT NULL,
        geometry_kind text NOT NULL CHECK (geometry_kind IN ('point','multipoint','line','multiline','polygon','multipolygon','circle')),
        properties jsonb NOT NULL,
        radius_m double precision,
        checksum text NOT NULL,
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_feature_geometry_2d CHECK (ST_NDims(geometry) = 2 AND NOT ST_IsEmpty(geometry)),
        CONSTRAINT ck_feature_geometry_type CHECK (GeometryType(geometry) IN ('POINT','MULTIPOINT','LINESTRING','MULTILINESTRING','POLYGON','MULTIPOLYGON')),
        CONSTRAINT ck_circle_radius CHECK (
          (geometry_kind = 'circle' AND GeometryType(geometry) = 'POINT' AND radius_m > 0)
          OR (geometry_kind <> 'circle' AND radius_m IS NULL)
        ),
        CONSTRAINT ck_properties_size CHECK (octet_length(properties::text) <= 65536)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_feature_versions_geometry ON feature_versions USING gist(geometry)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_feature_versions_revision ON feature_versions(revision_id, feature_id)',
    );

    await queryRunner.query(`
      CREATE TABLE revision_features (
        revision_id uuid NOT NULL REFERENCES layer_revisions(id) ON DELETE CASCADE,
        feature_id uuid NOT NULL REFERENCES features(id),
        feature_version_id uuid NOT NULL REFERENCES feature_versions(id),
        ordinal integer NOT NULL DEFAULT 0,
        PRIMARY KEY (revision_id, feature_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_revision_features_version ON revision_features(feature_version_id)',
    );

    await queryRunner.query(`
      CREATE TABLE revision_changes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        revision_id uuid NOT NULL REFERENCES layer_revisions(id) ON DELETE CASCADE,
        server_cursor bigint NOT NULL,
        operation text NOT NULL CHECK (operation IN ('create','update','delete')),
        feature_id uuid NOT NULL REFERENCES features(id),
        version_id uuid REFERENCES feature_versions(id),
        changed_paths text[] NOT NULL DEFAULT '{}'::text[],
        actor_id uuid NOT NULL REFERENCES users(id),
        changed_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_revision_cursor UNIQUE (revision_id, server_cursor)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE client_mutations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        revision_id uuid NOT NULL REFERENCES layer_revisions(id) ON DELETE CASCADE,
        client_id text NOT NULL,
        mutation_id uuid NOT NULL,
        request_digest text NOT NULL,
        response_payload jsonb NOT NULL,
        server_cursor bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_client_mutation UNIQUE (revision_id, client_id, mutation_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE revision_participants (
        revision_id uuid NOT NULL REFERENCES layer_revisions(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id),
        participation_type text NOT NULL CHECK (participation_type IN ('edit','review','publish')),
        participated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (revision_id, user_id, participation_type)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE workflow_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        revision_id uuid NOT NULL REFERENCES layer_revisions(id),
        from_status text NOT NULL,
        to_status text NOT NULL,
        actor_id uuid NOT NULL REFERENCES users(id),
        reason text,
        occurred_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_workflow_events_revision ON workflow_events(revision_id, occurred_at)',
    );

    await queryRunner.query(`
      CREATE TABLE publication_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        layer_id uuid NOT NULL REFERENCES layers(id),
        revision_id uuid NOT NULL REFERENCES layer_revisions(id),
        status text NOT NULL CHECK (status IN ('building','published','failed')),
        generation bigint NOT NULL CHECK (generation > 0),
        feature_count integer NOT NULL DEFAULT 0 CHECK (feature_count >= 0),
        bounds double precision[],
        checksum text NOT NULL,
        manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
        published_by uuid NOT NULL REFERENCES users(id),
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_publication_generation UNIQUE (layer_id, generation),
        CONSTRAINT ck_bounds_length CHECK (bounds IS NULL OR cardinality(bounds) = 4)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE layer_publications (
        layer_id uuid PRIMARY KEY REFERENCES layers(id),
        active_snapshot_id uuid NOT NULL REFERENCES publication_snapshots(id),
        previous_snapshot_id uuid REFERENCES publication_snapshots(id),
        pointer_updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE import_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        revision_id uuid NOT NULL REFERENCES layer_revisions(id),
        actor_id uuid NOT NULL REFERENCES users(id),
        object_key text NOT NULL,
        file_name text NOT NULL,
        size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
        format text NOT NULL CHECK (format IN ('csv','xlsx','geojson','kml')),
        mode text NOT NULL CHECK (mode IN ('append','replace','upsert')),
        status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','inspecting','mapping_required','validating','ready','applying','completed','cancelled','failed','rolled_back')),
        progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
        counts jsonb NOT NULL DEFAULT '{}'::jsonb,
        idempotency_key uuid NOT NULL,
        failure_code text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_import_idempotency UNIQUE (revision_id, idempotency_key)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_import_jobs_actor_status ON import_jobs(actor_id, status, created_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id uuid REFERENCES users(id),
        actor_role text,
        action text NOT NULL,
        resource_type text NOT NULL,
        resource_id uuid,
        request_id uuid NOT NULL,
        before_digest text,
        after_digest text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id, occurred_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_audit_actor ON audit_logs(actor_id, occurred_at DESC)',
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION danangmap_reject_immutable_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'immutable audit/workflow records cannot be changed';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_logs_immutable
      BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION danangmap_reject_immutable_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_workflow_events_immutable
      BEFORE UPDATE OR DELETE ON workflow_events
      FOR EACH ROW EXECUTE FUNCTION danangmap_reject_immutable_mutation()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS trg_workflow_events_immutable ON workflow_events',
    );
    await queryRunner.query('DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs');
    await queryRunner.query('DROP FUNCTION IF EXISTS danangmap_reject_immutable_mutation');
    for (const table of [
      'audit_logs',
      'import_jobs',
      'layer_publications',
      'publication_snapshots',
      'workflow_events',
      'revision_participants',
      'client_mutations',
      'revision_changes',
      'revision_features',
      'feature_versions',
      'features',
      'layer_fields',
      'layer_revisions',
      'layers',
      'layer_groups',
      'mail_outbox',
      'invites',
      'admin_sessions',
      'users',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }
}
