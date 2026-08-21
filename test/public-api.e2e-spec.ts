const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';

describe('Public API E2E', () => {
  it('serves the seeded published catalog', async () => {
    const response = await fetch(`${apiBaseUrl}/api/v1/public/layers`);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();
    const body = (await response.json()) as {
      data: Array<{ slug: string; generation: number }>;
    };
    expect(JSON.stringify(body)).not.toContain('internal_note');
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'schools', generation: 1 }),
        expect.objectContaining({ slug: 'new-wards', generation: 1 }),
      ]),
    );
  });

  it('returns bbox GeoJSON while stripping private properties', async () => {
    const response = await fetch(
      `${apiBaseUrl}/api/v1/public/layers/schools/features?bbox=108,15.8,108.5,16.3&limit=100`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      type: string;
      features: Array<{ properties: Record<string, unknown> }>;
    };
    expect(body.type).toBe('FeatureCollection');
    expect(body.features).toHaveLength(1);
    expect(body.features[0]?.properties).toMatchObject({
      name: 'Trường cao đẳng văn hóa nghệ thuật',
    });
    expect(body.features[0]?.properties).not.toHaveProperty('internal_note');
  });

  it('supports immutable feature ETags and conditional GET', async () => {
    const url = `${apiBaseUrl}/api/v1/public/layers/schools/features/40000000-0000-4000-8000-000000000001`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const body = (await first.json()) as { data: { properties: Record<string, unknown> } };
    expect(body.data.properties).not.toHaveProperty('internal_note');

    const conditional = await fetch(url, { headers: { 'If-None-Match': etag! } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
  });

  it('keeps internal search available when Geo Service is unconfigured', async () => {
    const response = await fetch(`${apiBaseUrl}/api/v1/public/search?q=Trường`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ source: string; featureId: string }>;
      meta: { partial: boolean; sources: { geoService: { status: string } } };
    };
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'internal',
          featureId: '40000000-0000-4000-8000-000000000001',
        }),
      ]),
    );
    expect(body.meta.partial).toBe(true);
    expect(body.meta.sources.geoService.status).toBe('unavailable');
  });

  it('returns an immutable MVT without private property keys', async () => {
    const z = 14;
    const longitude = 108.246206;
    const latitude = 16.047488;
    const x = Math.floor(((longitude + 180) / 360) * 2 ** z);
    const latitudeRadians = (latitude * Math.PI) / 180;
    const y = Math.floor(((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * 2 ** z);
    const response = await fetch(`${apiBaseUrl}/api/v1/public/tiles/schools/1/${z}/${x}/${y}.pbf`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    const tile = Buffer.from(await response.arrayBuffer());
    expect(tile.byteLength).toBeGreaterThan(0);
    expect(tile.includes(Buffer.from('internal_note'))).toBe(false);
  });

  it.each([
    '/api/v1/public/layers/schools/features?limit=NaN',
    '/api/v1/public/layers/schools/features?filter=internal_note:eq:secret',
    '/api/v1/public/search?q=test&limit=NaN',
    '/api/v1/public/search?q=test&center=bad',
    '/api/v1/public/search?q=test&center=16,108&radiusM=NaN',
    '/api/v1/public/search?q=test&layerIds=not-a-uuid',
  ])('rejects invalid public query input with 400: %s', async (path) => {
    const response = await fetch(`${apiBaseUrl}${path}`);
    expect(response.status).toBe(400);
  });
});
