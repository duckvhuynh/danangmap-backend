import type { DataSource } from 'typeorm';
import type { GeoServiceAdapter } from '../src/public-api/geo-service.adapter';
import { PublicApiService } from '../src/public-api/public-api.service';

describe('PublicApiService catalog source policy', () => {
  it('forces MVT when a hybrid snapshot exceeds the full GeoJSON default limit', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: '20000000-0000-4000-8000-000000000001',
        slug: 'large-hybrid',
        displayOrder: 1,
        groupId: null,
        groupSlug: null,
        groupTitle: null,
        groupDisplayOrder: null,
        title: 'Large hybrid layer',
        description: null,
        geometryMode: 'mixed',
        allowedGeometryKinds: ['point'],
        snapshotId: '60000000-0000-4000-8000-000000000001',
        revisionId: '30000000-0000-4000-8000-000000000001',
        generation: '1',
        featureCount: 1001,
        bounds: null,
        style: {},
        renderConfig: { sourcePolicy: 'hybrid' },
        popupConfig: {},
        manifest: { sourceKind: 'hybrid' },
        filterFields: [],
        searchFields: [],
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const service = new PublicApiService(
      { query } as unknown as DataSource,
      {} as GeoServiceAdapter,
    );

    const result = await service.catalog();

    expect(result.data).toEqual([
      expect.objectContaining({ slug: 'large-hybrid', featureCount: 1001, sourceKind: 'mvt' }),
    ]);
  });
});
