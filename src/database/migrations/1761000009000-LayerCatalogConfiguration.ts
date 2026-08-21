import type { MigrationInterface, QueryRunner } from 'typeorm';

export class LayerCatalogConfiguration1761000009000 implements MigrationInterface {
  name = 'LayerCatalogConfiguration1761000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE layers ADD COLUMN default_visible boolean NOT NULL DEFAULT true',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE layers DROP COLUMN default_visible');
  }
}
