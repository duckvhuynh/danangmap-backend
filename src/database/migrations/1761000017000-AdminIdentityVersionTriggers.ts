import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminIdentityVersionTriggers1761000017000 implements MigrationInterface {
  name = 'AdminIdentityVersionTriggers1761000017000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION touch_identity_user_lock() RETURNS trigger AS $$
      DECLARE target_user_id uuid;
      BEGIN
        target_user_id := CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
        UPDATE users
        SET lock_version=lock_version+1,updated_at=now()
        WHERE id=target_user_id;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const table of [
      'admin_sessions',
      'user_mfa_methods',
      'user_mfa_recovery_codes',
      'password_reset_tokens',
    ]) {
      await queryRunner.query(`
        CREATE TRIGGER trg_${table}_touch_user_lock
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION touch_identity_user_lock()
      `);
    }
    await queryRunner.query(`
      CREATE FUNCTION touch_invite_identity_user_lock() RETURNS trigger AS $$
      BEGIN
        UPDATE users
        SET lock_version=lock_version+1,updated_at=now()
        WHERE email_normalized=lower(
          CASE WHEN TG_OP='DELETE' THEN OLD.email ELSE NEW.email END
        );
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_invites_touch_user_lock
      AFTER INSERT OR UPDATE OR DELETE ON invites
      FOR EACH ROW EXECUTE FUNCTION touch_invite_identity_user_lock()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER trg_invites_touch_user_lock ON invites');
    await queryRunner.query('DROP FUNCTION touch_invite_identity_user_lock');
    for (const table of [
      'password_reset_tokens',
      'user_mfa_recovery_codes',
      'user_mfa_methods',
      'admin_sessions',
    ]) {
      await queryRunner.query(`DROP TRIGGER trg_${table}_touch_user_lock ON ${table}`);
    }
    await queryRunner.query('DROP FUNCTION touch_identity_user_lock');
  }
}
