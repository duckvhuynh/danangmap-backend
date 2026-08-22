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

  it('seeds an isolated approved three-feature successor for durable activation', async () => {
    const rows = (await AppDataSource.query(
      `SELECT layer.id AS "layerId",approved.id AS "revisionId",
              published.id AS "publishedRevisionId",snapshot.id AS "snapshotId",
              snapshot.generation::integer AS generation,
              pointer.active_snapshot_id AS "activeSnapshotId",
              (SELECT count(*)::integer FROM revision_features
               WHERE revision_id=approved.id) AS "featureTotal",
              (SELECT count(*)::integer FROM publication_snapshots
               WHERE layer_id=layer.id) AS "snapshotTotal",
              (SELECT count(*)::integer FROM publication_jobs
               WHERE layer_id=layer.id) AS "jobTotal",
              (SELECT count(*)::integer FROM revision_features link
               JOIN feature_versions version ON version.id=link.feature_version_id
               WHERE link.revision_id=approved.id
                 AND version.properties->>'activation_run_nonce'=$1)
                AS "runNonceFeatureTotal",
              (SELECT count(*)::integer FROM revision_participants participant
               WHERE participant.revision_id=approved.id
                 AND participant.user_id='00000000-0000-4000-8000-000000000004'
                 AND participant.participation_type IN ('edit','review')) AS "publisherEditorialTotal"
       FROM layers layer
       JOIN layer_revisions published
         ON published.layer_id=layer.id AND published.status='published'
       JOIN layer_revisions approved
         ON approved.layer_id=layer.id AND approved.status='approved'
       JOIN layer_publications pointer ON pointer.layer_id=layer.id
       JOIN publication_snapshots snapshot ON snapshot.id=pointer.active_snapshot_id
       WHERE layer.slug='durable-publication-activation'`,
      [process.env.DANANGMAP_RUN_NONCE ?? 'integration-durable-publication'],
    )) as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      expect.objectContaining({
        layerId: '20000000-0000-4000-8000-000000000004',
        revisionId: '30000000-0000-4000-8000-000000000006',
        publishedRevisionId: '30000000-0000-4000-8000-000000000005',
        snapshotId: '60000000-0000-4000-8000-000000000004',
        activeSnapshotId: '60000000-0000-4000-8000-000000000004',
        generation: 1,
        featureTotal: 3,
        snapshotTotal: 1,
        jobTotal: 0,
        runNonceFeatureTotal: 3,
        publisherEditorialTotal: 0,
      }),
    ]);
  });
});
