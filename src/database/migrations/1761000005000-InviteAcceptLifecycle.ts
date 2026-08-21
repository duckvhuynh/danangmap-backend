import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InviteAcceptLifecycle1761000005000 implements MigrationInterface {
  name = 'InviteAcceptLifecycle1761000005000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE invites
        ADD COLUMN accepted_user_id uuid,
        ADD CONSTRAINT fk_invites_accepted_user
          FOREIGN KEY (accepted_user_id) REFERENCES users(id) ON DELETE SET NULL
    `);
    await queryRunner.query(
      'CREATE INDEX idx_invites_accepted_user ON invites(accepted_user_id) WHERE accepted_user_id IS NOT NULL',
    );
    await queryRunner.query(`
      ALTER TABLE mail_outbox
        ADD COLUMN invite_id uuid,
        ADD CONSTRAINT fk_mail_outbox_invite
          FOREIGN KEY (invite_id) REFERENCES invites(id) ON DELETE SET NULL
    `);
    await queryRunner.query(
      'CREATE INDEX idx_mail_outbox_invite ON mail_outbox(invite_id) WHERE invite_id IS NOT NULL',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_mail_outbox_invite');
    await queryRunner.query('ALTER TABLE mail_outbox DROP CONSTRAINT fk_mail_outbox_invite');
    await queryRunner.query('ALTER TABLE mail_outbox DROP COLUMN invite_id');
    await queryRunner.query('DROP INDEX idx_invites_accepted_user');
    await queryRunner.query('ALTER TABLE invites DROP CONSTRAINT fk_invites_accepted_user');
    await queryRunner.query('ALTER TABLE invites DROP COLUMN accepted_user_id');
  }
}
