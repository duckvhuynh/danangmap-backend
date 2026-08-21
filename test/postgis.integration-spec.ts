import AppDataSource from '../src/database/data-source';
import { GeometryService } from '../src/layers/geometry.service';

describe('PostGIS integration', () => {
  let geometry: GeometryService;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    geometry = new GeometryService(AppDataSource);
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  it('has PostGIS and all migrations applied', async () => {
    const extension = (await AppDataSource.query(
      `SELECT extversion FROM pg_extension WHERE extname='postgis'`,
    )) as Array<{ extversion: string }>;
    expect(extension[0]?.extversion).toMatch(/^3\./);
    await expect(AppDataSource.showMigrations()).resolves.toBe(false);
  });

  it('validates real 4326 multi geometry with PostGIS', async () => {
    await expect(
      geometry.validate(
        {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [108.1, 16],
                [108.2, 16],
                [108.2, 16.1],
                [108.1, 16],
              ],
            ],
          ],
        },
        'multipolygon',
      ),
    ).resolves.toEqual(expect.objectContaining({ type: 'MULTIPOLYGON', valid: true }));
  });

  it('rejects MultiPoint as a circle canonical geometry', async () => {
    await expect(
      geometry.validate({ type: 'MultiPoint', coordinates: [[108.2, 16.06]] }, 'circle', 100),
    ).rejects.toMatchObject({ code: 'GEOMETRY_TYPE_NOT_ALLOWED' });
  });

  it('created a GIST index for the spatial hot path', async () => {
    const indexes = (await AppDataSource.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname='idx_feature_versions_geometry'`,
    )) as Array<{ indexdef: string }>;
    expect(indexes[0]?.indexdef.toLowerCase()).toContain('using gist');
  });
});
