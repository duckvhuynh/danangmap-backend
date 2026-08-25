import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DurableFeatureSync1761000018000 implements MigrationInterface {
  name = 'DurableFeatureSync1761000018000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE layer_revisions
      ADD COLUMN change_cursor_floor bigint NOT NULL DEFAULT 0,
      ADD CONSTRAINT ck_layer_revision_change_cursor_floor
        CHECK (change_cursor_floor >= 0 AND change_cursor_floor <= cursor_seq)
    `);
    await queryRunner.query(`
      ALTER TABLE client_mutations
      ADD COLUMN client_feature_id uuid,
      ADD COLUMN canonical_feature_id uuid REFERENCES features(id)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_client_feature_mapping
      ON client_mutations(revision_id,client_id,client_feature_id)
      WHERE client_feature_id IS NOT NULL AND canonical_feature_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_client_mutations_created_at
      ON client_mutations(created_at)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_revision_changes_feed
      ON revision_changes(revision_id,server_cursor,changed_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_revision_changes_feed');
    await queryRunner.query('DROP INDEX IF EXISTS idx_client_mutations_created_at');
    await queryRunner.query('DROP INDEX IF EXISTS uq_client_feature_mapping');
    await queryRunner.query(`
      ALTER TABLE client_mutations
      DROP COLUMN IF EXISTS canonical_feature_id,
      DROP COLUMN IF EXISTS client_feature_id
    `);
    await queryRunner.query(`
      ALTER TABLE layer_revisions
      DROP CONSTRAINT IF EXISTS ck_layer_revision_change_cursor_floor,
      DROP COLUMN IF EXISTS change_cursor_floor
    `);
  }
}
