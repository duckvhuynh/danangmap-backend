import { randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';
import { GeometryService } from '../src/layers/geometry.service';
import type { GeoServiceAdapter } from '../src/public-api/geo-service.adapter';
import { PublicApiService } from '../src/public-api/public-api.service';

function readVarint(buffer: Buffer, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < buffer.byteLength && shift <= 49) {
    const byte = buffer[offset]!;
    value += (byte & 0x7f) * 2 ** shift;
    offset += 1;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
  throw new Error('Invalid protobuf varint');
}

function protobufFields(buffer: Buffer, target: number): Array<number | Buffer> {
  const values: Array<number | Buffer> = [];
  let offset = 0;
  while (offset < buffer.byteLength) {
    const [tag, afterTag] = readVarint(buffer, offset);
    offset = afterTag;
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      const [value, afterValue] = readVarint(buffer, offset);
      if (field === target) values.push(value);
      offset = afterValue;
    } else if (wireType === 2) {
      const [length, afterLength] = readVarint(buffer, offset);
      const end = afterLength + length;
      if (end > buffer.byteLength) throw new Error('Invalid protobuf field length');
      if (field === target) values.push(buffer.subarray(afterLength, end));
      offset = end;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
  return values;
}

function mvtGeometryTypes(tile: Buffer): number[] {
  return protobufFields(tile, 3)
    .filter((value): value is Buffer => Buffer.isBuffer(value))
    .flatMap((layer) =>
      protobufFields(layer, 2).filter((value): value is Buffer => Buffer.isBuffer(value)),
    )
    .flatMap((feature) => protobufFields(feature, 3).filter((value) => typeof value === 'number'));
}

describe('PostGIS integration', () => {
  let geometry: GeometryService;
  let publicApi: PublicApiService;
  const circleFixture = {
    layerId: randomUUID(),
    revisionId: randomUUID(),
    featureId: randomUUID(),
    versionId: randomUUID(),
    snapshotId: randomUUID(),
    slug: `circle-mvt-${randomUUID()}`,
  };

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    geometry = new GeometryService(AppDataSource);
    publicApi = new PublicApiService(AppDataSource, {} as GeoServiceAdapter);
    await AppDataSource.query(
      `INSERT INTO layers(id,slug,created_by) VALUES($1,$2,'00000000-0000-4000-8000-000000000002')`,
      [circleFixture.layerId, circleFixture.slug],
    );
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
        id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,created_by,published_at
       ) VALUES($1,$2,1,'published','Circle MVT fixture','circle',ARRAY['circle'],
         '00000000-0000-4000-8000-000000000002',now())`,
      [circleFixture.revisionId, circleFixture.layerId],
    );
    await AppDataSource.query(`INSERT INTO features(id,layer_id) VALUES($1,$2)`, [
      circleFixture.featureId,
      circleFixture.layerId,
    ]);
    await AppDataSource.query(
      `INSERT INTO feature_versions(
        id,feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by
       ) VALUES($1,$2,$3,ST_SetSRID(ST_Point(108.2208,16.0678),4326),'circle','{}',250,'circle-fixture',
         '00000000-0000-4000-8000-000000000002')`,
      [circleFixture.versionId, circleFixture.featureId, circleFixture.revisionId],
    );
    await AppDataSource.query(
      `INSERT INTO revision_features(revision_id,feature_id,feature_version_id)
       VALUES($1,$2,$3)`,
      [circleFixture.revisionId, circleFixture.featureId, circleFixture.versionId],
    );
    await AppDataSource.query(
      `INSERT INTO publication_snapshots(
        id,layer_id,revision_id,status,generation,feature_count,bounds,checksum,manifest,published_by,published_at
       ) VALUES($1,$2,$3,'published',1,1,ARRAY[108.218,16.065,108.224,16.071],
         'circle-fixture','{}','00000000-0000-4000-8000-000000000004',now())`,
      [circleFixture.snapshotId, circleFixture.layerId, circleFixture.revisionId],
    );
    await AppDataSource.query(
      `INSERT INTO layer_publications(layer_id,active_snapshot_id) VALUES($1,$2)`,
      [circleFixture.layerId, circleFixture.snapshotId],
    );
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.query('DELETE FROM layer_publications WHERE layer_id=$1', [
        circleFixture.layerId,
      ]);
      await AppDataSource.query('DELETE FROM publication_snapshots WHERE id=$1', [
        circleFixture.snapshotId,
      ]);
      await AppDataSource.query('DELETE FROM revision_features WHERE revision_id=$1', [
        circleFixture.revisionId,
      ]);
      await AppDataSource.query('DELETE FROM feature_versions WHERE id=$1', [
        circleFixture.versionId,
      ]);
      await AppDataSource.query('DELETE FROM features WHERE id=$1', [circleFixture.featureId]);
      await AppDataSource.query('DELETE FROM layer_revisions WHERE id=$1', [
        circleFixture.revisionId,
      ]);
      await AppDataSource.query('DELETE FROM layers WHERE id=$1', [circleFixture.layerId]);
      await AppDataSource.destroy();
    }
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

  it('renders a meter-radius circle as a non-empty polygon MVT feature', async () => {
    const tile = await publicApi.tile(circleFixture.slug, 1, 14, 13117, 7450);
    expect(tile.tile.byteLength).toBeGreaterThan(0);
    expect(mvtGeometryTypes(tile.tile)).toContain(3);
  });

  it('buffers the circle in meters within a two-percent area tolerance', async () => {
    const rows = (await AppDataSource.query(
      `SELECT radius_m AS radius,
              ST_Area(ST_Buffer(geometry::geography,radius_m)::geography) AS area
       FROM feature_versions WHERE id=$1`,
      [circleFixture.versionId],
    )) as Array<{ radius: number; area: number }>;
    const expectedArea = Math.PI * 250 ** 2;
    expect(rows[0]?.radius).toBe(250);
    expect(Math.abs(Number(rows[0]?.area) - expectedArea) / expectedArea).toBeLessThan(0.02);
  });

  it('keeps the canonical public GeoJSON circle as Point plus radiusM', async () => {
    const collection = await publicApi.featureCollection(circleFixture.slug, undefined, 10);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]).toMatchObject({
      geometry: { type: 'Point', coordinates: [108.2208, 16.0678] },
      geometryKind: 'circle',
      radiusM: 250,
    });
  });
});
