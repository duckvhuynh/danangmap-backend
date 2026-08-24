import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AttachmentLifecycle1761000015000 implements MigrationInterface {
  name = 'AttachmentLifecycle1761000015000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE attachments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        purpose text NOT NULL DEFAULT 'feature_attachment',
        quarantine_key text NOT NULL UNIQUE,
        object_key text UNIQUE,
        file_name text NOT NULL,
        declared_content_type text NOT NULL,
        content_type text,
        declared_size_bytes integer NOT NULL,
        size_bytes integer,
        declared_sha256 text NOT NULL,
        sha256 text,
        status text NOT NULL DEFAULT 'uploading',
        rejection_code text,
        owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        upload_expires_at timestamptz NOT NULL,
        finalized_at timestamptz,
        scanned_at timestamptz,
        quarantine_removed_at timestamptz,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_attachments_purpose CHECK (purpose='feature_attachment'),
        CONSTRAINT ck_attachments_status CHECK (
          status IN ('uploading','pending','clean','infected','rejected','deleted')
        ),
        CONSTRAINT ck_attachments_declared_size CHECK (
          declared_size_bytes BETWEEN 1 AND 26214400
        ),
        CONSTRAINT ck_attachments_verified_size CHECK (
          size_bytes IS NULL OR size_bytes BETWEEN 1 AND 26214400
        ),
        CONSTRAINT ck_attachments_declared_sha CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT ck_attachments_verified_sha CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_attachments_owner_status_created
       ON attachments(owner_id,status,created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_attachments_cleanup
       ON attachments(status,upload_expires_at,id)
       WHERE status IN ('uploading','clean','infected','rejected','deleted')`,
    );

    await queryRunner.query(`
      CREATE TABLE feature_version_attachments (
        feature_version_id uuid NOT NULL REFERENCES feature_versions(id) ON DELETE CASCADE,
        attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
        field_key text NOT NULL,
        display_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(feature_version_id,attachment_id),
        CONSTRAINT ck_feature_version_attachment_field_key
          CHECK (field_key ~ '^[a-z][a-z0-9_]{1,63}$'),
        CONSTRAINT ck_feature_version_attachment_order
          CHECK (display_order BETWEEN 0 AND 100000)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_feature_version_attachments_order
       ON feature_version_attachments(feature_version_id,field_key,display_order,attachment_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_feature_version_attachments_attachment
       ON feature_version_attachments(attachment_id,feature_version_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS feature_version_attachments');
    await queryRunner.query('DROP TABLE IF EXISTS attachments');
  }
}
