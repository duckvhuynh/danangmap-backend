import type { MigrationInterface, QueryRunner } from 'typeorm';

export class LayerLifecycleVersions1761000010000 implements MigrationInterface {
  name = 'LayerLifecycleVersions1761000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE layer_groups ADD COLUMN lock_version integer NOT NULL DEFAULT 1 CHECK (lock_version > 0)',
    );
    await queryRunner.query(
      'ALTER TABLE layers ADD COLUMN lock_version integer NOT NULL DEFAULT 1 CHECK (lock_version > 0)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE layers DROP COLUMN lock_version');
    await queryRunner.query('ALTER TABLE layer_groups DROP COLUMN lock_version');
  }
}
