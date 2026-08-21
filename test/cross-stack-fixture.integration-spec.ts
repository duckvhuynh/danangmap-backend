import AppDataSource from '../src/database/data-source';

const fixture = {
  layerId: '20000000-0000-4000-8000-000000000003',
  publishedRevisionId: '30000000-0000-4000-8000-000000000003',
  draftRevisionId: '30000000-0000-4000-8000-000000000004',
  snapshotId: '60000000-0000-4000-8000-000000000003',
};

describe('Cross-stack publication fixture', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  it('starts from a deterministic generation-one publication and editable successor', async () => {
    const layers = (await AppDataSource.query(`SELECT slug FROM layers WHERE id=$1`, [
      fixture.layerId,
    ])) as Array<{ slug: string }>;
    expect(layers).toEqual([{ slug: 'cross-stack-publication' }]);

    const revisions = (await AppDataSource.query(
      `SELECT id,status,revision_no FROM layer_revisions WHERE layer_id=$1 ORDER BY revision_no`,
      [fixture.layerId],
    )) as Array<{ id: string; status: string; revision_no: number }>;
    expect(revisions).toEqual([
      { id: fixture.publishedRevisionId, status: 'published', revision_no: 1 },
      { id: fixture.draftRevisionId, status: 'draft', revision_no: 2 },
    ]);

    const featureCounts = (await AppDataSource.query(
      `SELECT revision_id,count(*)::int AS count
       FROM revision_features WHERE revision_id=ANY($1::uuid[])
       GROUP BY revision_id ORDER BY revision_id`,
      [[fixture.publishedRevisionId, fixture.draftRevisionId]],
    )) as Array<{ revision_id: string; count: number }>;
    expect(featureCounts).toEqual([
      { revision_id: fixture.publishedRevisionId, count: 1 },
      { revision_id: fixture.draftRevisionId, count: 1 },
    ]);

    const publications = (await AppDataSource.query(
      `SELECT ps.id,ps.generation::int AS generation,ps.feature_count,lp.active_snapshot_id
       FROM layer_publications lp
       JOIN publication_snapshots ps ON ps.id=lp.active_snapshot_id
       WHERE lp.layer_id=$1`,
      [fixture.layerId],
    )) as Array<{
      id: string;
      generation: number;
      feature_count: number;
      active_snapshot_id: string;
    }>;
    expect(publications).toEqual([
      {
        id: fixture.snapshotId,
        generation: 1,
        feature_count: 1,
        active_snapshot_id: fixture.snapshotId,
      },
    ]);
  });
});
