import type { MigrationInterface, QueryRunner } from 'typeorm';

export class HistoryReadIndexes1761000012000 implements MigrationInterface {
  name = 'HistoryReadIndexes1761000012000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE publication_snapshots ADD COLUMN activated_at timestamptz`,
    );
    await queryRunner.query(
      `UPDATE publication_snapshots SET activated_at=published_at
       WHERE status='published' AND published_at IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_publication_activated_history
       ON publication_snapshots(layer_id,activated_at DESC,generation DESC)
       WHERE activated_at IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_publication_revision_generation
       ON publication_snapshots(revision_id,generation DESC)`,
    );
    await queryRunner.query(`
      CREATE TABLE audit_layer_scopes (
        audit_id uuid NOT NULL REFERENCES audit_logs(id) ON DELETE CASCADE,
        layer_id uuid NOT NULL REFERENCES layers(id),
        occurred_at timestamptz NOT NULL,
        PRIMARY KEY(audit_id,layer_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_audit_layer_scope_cursor
       ON audit_layer_scopes(layer_id,occurred_at DESC,audit_id DESC)`,
    );
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION danangmap_reject_audit_scope_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'immutable audit layer scope records cannot be changed';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_layer_scopes_immutable
      BEFORE UPDATE OR DELETE ON audit_layer_scopes
      FOR EACH ROW EXECUTE FUNCTION danangmap_reject_audit_scope_mutation()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION danangmap_scope_audit_layer()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.resource_type='layer' AND NEW.resource_id IS NOT NULL THEN
          INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
          SELECT NEW.id,id,NEW.occurred_at FROM layers WHERE id=NEW.resource_id
          ON CONFLICT DO NOTHING;
        ELSIF NEW.resource_type IN ('revision','layer_revision') AND NEW.resource_id IS NOT NULL THEN
          INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
          SELECT NEW.id,layer_id,NEW.occurred_at FROM layer_revisions WHERE id=NEW.resource_id
          ON CONFLICT DO NOTHING;
        ELSIF NEW.resource_type='feature' AND NEW.resource_id IS NOT NULL THEN
          INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
          SELECT NEW.id,layer_id,NEW.occurred_at FROM features WHERE id=NEW.resource_id
          ON CONFLICT DO NOTHING;
        ELSIF NEW.resource_type='import_job' AND NEW.resource_id IS NOT NULL THEN
          INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
          SELECT NEW.id,revision.layer_id,NEW.occurred_at
          FROM import_jobs job JOIN layer_revisions revision ON revision.id=job.revision_id
          WHERE job.id=NEW.resource_id ON CONFLICT DO NOTHING;
        ELSIF NEW.resource_type='publication' AND NEW.resource_id IS NOT NULL THEN
          INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
          SELECT NEW.id,layer_id,NEW.occurred_at FROM publication_snapshots WHERE id=NEW.resource_id
          ON CONFLICT DO NOTHING;
        ELSIF NEW.resource_type='layer_group' AND NEW.resource_id IS NOT NULL THEN
          INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
          SELECT NEW.id,id,NEW.occurred_at FROM layers WHERE group_id=NEW.resource_id
          ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_audit_layer_scope
      AFTER INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION danangmap_scope_audit_layer()
    `);
    await queryRunner.query(`
      INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
      SELECT audit.id,layer.id,audit.occurred_at
      FROM audit_logs audit JOIN layers layer
        ON audit.resource_type='layer' AND audit.resource_id=layer.id
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
      SELECT audit.id,revision.layer_id,audit.occurred_at
      FROM audit_logs audit JOIN layer_revisions revision
        ON audit.resource_type IN ('revision','layer_revision') AND audit.resource_id=revision.id
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
      SELECT audit.id,feature.layer_id,audit.occurred_at
      FROM audit_logs audit JOIN features feature
        ON audit.resource_type='feature' AND audit.resource_id=feature.id
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
      SELECT audit.id,revision.layer_id,audit.occurred_at
      FROM audit_logs audit JOIN import_jobs job
        ON audit.resource_type='import_job' AND audit.resource_id=job.id
      JOIN layer_revisions revision ON revision.id=job.revision_id
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
      SELECT audit.id,snapshot.layer_id,audit.occurred_at
      FROM audit_logs audit JOIN publication_snapshots snapshot
        ON audit.resource_type='publication' AND audit.resource_id=snapshot.id
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO audit_layer_scopes(audit_id,layer_id,occurred_at)
      SELECT audit.id,layer.id,audit.occurred_at
      FROM audit_logs audit JOIN layers layer
        ON audit.resource_type='layer_group' AND audit.resource_id=layer.group_id
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(
      `CREATE INDEX idx_audit_history_cursor ON audit_logs(occurred_at DESC,id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_audit_action_history_cursor ON audit_logs(action,occurred_at DESC,id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_audit_request_history_cursor
       ON audit_logs(request_id,occurred_at DESC,id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_audit_resource_type_history_cursor
       ON audit_logs(resource_type,occurred_at DESC,id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_audit_resource_id_history_cursor
       ON audit_logs(resource_id,occurred_at DESC,id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_audit_actor_history_cursor
       ON audit_logs(actor_id,occurred_at DESC,id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_workflow_history_cursor
       ON workflow_events(revision_id,occurred_at DESC,id DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_workflow_history_cursor`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_audit_actor_history_cursor`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_audit_resource_id_history_cursor`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_audit_resource_type_history_cursor`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_audit_request_history_cursor`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_audit_action_history_cursor`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_audit_history_cursor`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_publication_revision_generation`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_publication_activated_history`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_audit_layer_scope ON audit_logs`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS danangmap_scope_audit_layer`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_audit_layer_scopes_immutable ON audit_layer_scopes`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS danangmap_reject_audit_scope_mutation`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_layer_scopes`);
    await queryRunner.query(`ALTER TABLE publication_snapshots DROP COLUMN activated_at`);
  }
}
