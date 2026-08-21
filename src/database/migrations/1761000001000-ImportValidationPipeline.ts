import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ImportValidationPipeline1761000001000 implements MigrationInterface {
  name = 'ImportValidationPipeline1761000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE import_staged_features (
        import_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
        row_number integer NOT NULL CHECK (row_number > 0),
        proposed_feature_id uuid NOT NULL,
        target_feature_id uuid REFERENCES features(id),
        geometry jsonb NOT NULL,
        geometry_kind text NOT NULL CHECK (geometry_kind IN ('point','multipoint','line','multiline','polygon','multipolygon','circle')),
        radius_m double precision,
        properties jsonb NOT NULL,
        external_source text,
        external_id text,
        PRIMARY KEY(import_id,row_number),
        CONSTRAINT ck_import_stage_external_pair CHECK ((external_source IS NULL) = (external_id IS NULL)),
        CONSTRAINT ck_import_stage_circle CHECK (
          (geometry_kind='circle' AND radius_m > 0)
          OR (geometry_kind<>'circle' AND radius_m IS NULL)
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_import_stage_target ON import_staged_features(import_id,target_feature_id)',
    );
    await queryRunner.query(`
      CREATE TABLE import_issues (
        id bigserial PRIMARY KEY,
        import_id uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
        row_number integer NOT NULL CHECK (row_number > 0),
        severity text NOT NULL CHECK (severity IN ('warning','error')),
        code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
        field text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_import_issues_page ON import_issues(import_id,id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE import_issues');
    await queryRunner.query('DROP TABLE import_staged_features');
  }
}
