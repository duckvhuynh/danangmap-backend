import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ActiveInviteIdentity1761000003000 implements MigrationInterface {
  name = 'ActiveInviteIdentity1761000003000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_invites_active_email ON invites(lower(email))
       WHERE used_at IS NULL AND revoked_at IS NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX uq_invites_active_email');
  }
}
