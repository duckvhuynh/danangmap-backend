import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OpenEditorialChain1761000011000 implements MigrationInterface {
  name = 'OpenEditorialChain1761000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_layer_open_editorial_chain
       ON layer_revisions(layer_id)
       WHERE status IN ('draft','in_review','approved','publishing')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX uq_layer_open_editorial_chain');
  }
}
