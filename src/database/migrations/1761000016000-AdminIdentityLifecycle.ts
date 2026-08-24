import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminIdentityLifecycle1761000016000 implements MigrationInterface {
  name = 'AdminIdentityLifecycle1761000016000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN lock_version integer NOT NULL DEFAULT 1,
        ADD CONSTRAINT ck_users_lock_version CHECK (lock_version > 0)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_users_admin_directory
      ON users(created_at DESC,id DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_users_admin_filters
      ON users(status,role,created_at DESC,id DESC)
    `);
    await queryRunner.query(`
      ALTER TABLE invites
        ADD COLUMN lock_version integer NOT NULL DEFAULT 1,
        ADD COLUMN supersedes_invite_id uuid REFERENCES invites(id) ON DELETE SET NULL,
        ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
        ADD CONSTRAINT ck_invites_lock_version CHECK (lock_version > 0)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_invites_admin_directory
      ON invites(created_at DESC,id DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_invites_admin_status
      ON invites(used_at,revoked_at,expires_at,created_at DESC,id DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_invites_supersedes
      ON invites(supersedes_invite_id)
      WHERE supersedes_invite_id IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_invites_supersedes');
    await queryRunner.query('DROP INDEX idx_invites_admin_status');
    await queryRunner.query('DROP INDEX idx_invites_admin_directory');
    await queryRunner.query(`
      ALTER TABLE invites
        DROP CONSTRAINT ck_invites_lock_version,
        DROP COLUMN updated_at,
        DROP COLUMN supersedes_invite_id,
        DROP COLUMN lock_version
    `);
    await queryRunner.query('DROP INDEX idx_users_admin_filters');
    await queryRunner.query('DROP INDEX idx_users_admin_directory');
    await queryRunner.query(`
      ALTER TABLE users
        DROP CONSTRAINT ck_users_lock_version,
        DROP COLUMN lock_version
    `);
  }
}
