import { ConfigService } from '@nestjs/config';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DataSource } from 'typeorm';
import {
  GeoServiceAdapter,
  GeoServiceUnavailableError,
} from '../src/public-api/geo-service.adapter';
import { PublicApiService } from '../src/public-api/public-api.service';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

describe('GeoServiceAdapter resilience and anti-corruption boundary', () => {
  let server: Server;
  let baseUrl: string;
  let handler: Handler;

  beforeAll(async () => {
    server = createServer((request, response) => handler(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    handler = (_request, response) => json(response, 200, { results: [] });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('uses only the three contract paths, forwards optional auth, and normalizes nullable positions', async () => {
    const requests: Array<{ path: string; query: URLSearchParams; authorization?: string }> = [];
    handler = (request, response) => {
      const url = new URL(request.url!, baseUrl);
      requests.push({
        path: url.pathname,
        query: url.searchParams,
        authorization: request.headers.authorization,
      });
      if (url.pathname.endsWith('place:details')) {
        return json(response, 200, {
          result: {
            place_id: 'details-1',
            name: 'Chi tiết địa điểm',
            formatted_address: 'Đà Nẵng',
            formatted_phone_number: '0236 123 456',
            provider_secret: 'must-not-pass-boundary',
          },
        });
      }
      const collection = url.pathname.endsWith('place:autocomplete') ? 'predictions' : 'results';
      return json(response, 200, {
        [collection]: [
          {
            place_id: `${collection}-1`,
            description: 'Địa điểm không có tọa độ',
            score: '0.75',
          },
        ],
      });
    };
    const adapter = createAdapter(baseUrl, { authHeader: 'Bearer test-only-secret' });

    const autocomplete = await adapter.autocomplete('cầu rồng', {
      latitude: 16.06,
      longitude: 108.22,
      radiusM: 2500,
    });
    const search = await adapter.textSearch('ủy ban');
    const details = await adapter.placeDetails('details-1', ['name', 'address', 'position']);

    expect(requests.map((request) => request.path)).toEqual([
      '/api/v1/geoservice/place:autocomplete',
      '/api/v1/geoservice/place:textsearch',
      '/api/v1/geoservice/place:details',
    ]);
    expect(requests[0]?.query.get('input')).toBe('cầu rồng');
    expect(requests[0]?.query.get('location')).toBe('16.06,108.22');
    expect(requests[0]?.query.get('radius')).toBe('2500');
    expect(requests[1]?.query.get('query')).toBe('ủy ban');
    expect(requests[2]?.query.get('place_id')).toBe('details-1');
    expect(requests[2]?.query.get('fields')).toBe('name,address,position');
    expect(requests.every((request) => request.authorization === 'Bearer test-only-secret')).toBe(
      true,
    );
    expect(autocomplete[0]).toMatchObject({ position: null, score: 0.75 });
    expect(search[0]).toMatchObject({ position: null, score: 0.75 });
    expect(details).toEqual({
      id: 'details-1',
      name: 'Chi tiết địa điểm',
      address: 'Đà Nẵng',
      position: null,
      phone: '0236 123 456',
      website: null,
    });
    expect(JSON.stringify(details)).not.toContain('provider_secret');
  });

  it('retries retryable responses but never retries provider 4xx responses', async () => {
    let attempts = 0;
    handler = (_request, response) => {
      attempts += 1;
      if (attempts === 1) return json(response, 503, { detail: 'temporary' });
      return json(response, 200, {
        results: [{ place_id: 'retry-ok', name: 'Đã phục hồi' }],
      });
    };
    const adapter = createAdapter(baseUrl, { retryAttempts: 3 });

    await expect(adapter.textSearch('retry')).resolves.toEqual([
      expect.objectContaining({ id: 'retry-ok' }),
    ]);
    expect(attempts).toBe(2);

    attempts = 0;
    handler = (_request, response) => {
      attempts += 1;
      json(response, 422, { detail: 'invalid query' });
    };
    await expect(adapter.textSearch('invalid')).rejects.toBeInstanceOf(GeoServiceUnavailableError);
    expect(attempts).toBe(1);
  });

  it('enforces the connect timeout budget without exposing provider details', async () => {
    let attempts = 0;
    handler = (request, response) => {
      attempts += 1;
      const timer = setTimeout(() => json(response, 200, { results: [] }), 500);
      request.on('close', () => clearTimeout(timer));
    };
    const adapter = createAdapter(baseUrl, {
      connectTimeoutMs: 25,
      totalTimeoutMs: 200,
      retryAttempts: 1,
      retryDelayMs: 5,
      authHeader: 'Bearer never-leak-this-value',
    });
    const startedAt = Date.now();

    const error = await adapter.textSearch('timeout').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GeoServiceUnavailableError);
    expect((error as Error).message).not.toContain('never-leak-this-value');
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBe(1);
  });

  it('enforces one total budget across response streaming and all retries', async () => {
    let attempts = 0;
    handler = (request, response) => {
      attempts += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
      response.write('{"results":');
      const timer = setTimeout(() => response.end('[]}'), 500);
      request.on('close', () => clearTimeout(timer));
    };
    const adapter = createAdapter(baseUrl, {
      connectTimeoutMs: 100,
      totalTimeoutMs: 60,
      retryAttempts: 3,
      retryDelayMs: 5,
    });
    const startedAt = Date.now();

    await expect(adapter.textSearch('slow-body')).rejects.toBeInstanceOf(
      GeoServiceUnavailableError,
    );

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(attempts).toBe(1);
  });

  it('opens the breaker, reports degraded readiness state, and resets only after recovery', async () => {
    let attempts = 0;
    let recovered = false;
    handler = (_request, response) => {
      attempts += 1;
      if (!recovered) return json(response, 503, { detail: 'offline' });
      return json(response, 200, { results: [{ place_id: 'recovered', name: 'Hoạt động' }] });
    };
    const adapter = createAdapter(baseUrl, {
      retryAttempts: 1,
      breakerFailureThreshold: 2,
      breakerOpenMs: 30,
    });

    await expect(adapter.textSearch('first')).rejects.toBeInstanceOf(GeoServiceUnavailableError);
    await expect(adapter.textSearch('second')).rejects.toBeInstanceOf(GeoServiceUnavailableError);
    expect(adapter.healthStatus).toBe('degraded');
    await expect(adapter.textSearch('open')).rejects.toBeInstanceOf(GeoServiceUnavailableError);
    expect(attempts).toBe(2);

    recovered = true;
    await new Promise((resolve) => setTimeout(resolve, 40));
    await expect(adapter.textSearch('half-open')).resolves.toEqual([
      expect.objectContaining({ id: 'recovered' }),
    ]);
    expect(attempts).toBe(3);
    expect(adapter.healthStatus).toBe('up');
  });

  it('rejects malformed runtime payloads and preserves internal results as a degraded partial 200', async () => {
    handler = (_request, response) =>
      json(response, 200, {
        results: [
          {
            place_id: 'invalid-location',
            name: 'Invalid',
            geometry: { location: { lat: null, lng: 108.22 } },
          },
        ],
      });
    const adapter = createAdapter(baseUrl, {
      retryAttempts: 1,
      breakerFailureThreshold: 1,
    });
    const internal = {
      id: 'feature:20000000-0000-4000-8000-000000000001',
      source: 'internal',
      kind: 'feature',
      title: 'Trụ sở nội bộ',
      subtitle: 'Đà Nẵng',
      position: { longitude: 108.22, latitude: 16.06 },
      bbox: null,
      layer: {
        id: '10000000-0000-4000-8000-000000000001',
        slug: 'offices',
        title: 'Trụ sở',
      },
      featureId: '20000000-0000-4000-8000-000000000001',
      providerPlaceId: null,
      score: 0.9,
      highlights: ['Trụ sở'],
    };
    const dataSource = { query: jest.fn().mockResolvedValue([internal]) } as unknown as DataSource;
    const service = new PublicApiService(dataSource, adapter);

    const result = await service.search({ q: 'Trụ sở', sources: 'internal,place' });

    expect(result.data).toEqual([internal]);
    expect(result.meta).toMatchObject({
      partial: true,
      sources: {
        internal: { status: 'ok', count: 1 },
        geoService: { status: 'unavailable', count: 0 },
      },
      warnings: [expect.objectContaining({ code: 'GEO_SERVICE_UNAVAILABLE' })],
    });
    expect(adapter.healthStatus).toBe('degraded');
  });

  it('enforces the public detail field allowlist and maps provider failures to a stable 503', async () => {
    let attempts = 0;
    handler = (_request, response) => {
      attempts += 1;
      json(response, 500, { raw_provider_error: 'must-not-leak' });
    };
    const adapter = createAdapter(baseUrl, { retryAttempts: 1 });
    const service = new PublicApiService({} as DataSource, adapter);

    const invalidFields = await service
      .placeDetails('place-1', 'name,raw_provider_error')
      .catch((error: unknown) => error);
    expect(invalidFields).toMatchObject({ code: 'INVALID_FIELDS' });
    expect((invalidFields as { getStatus(): number }).getStatus()).toBe(400);
    expect(attempts).toBe(0);

    const unavailable = await service
      .placeDetails('place-1', 'name,address,position')
      .catch((error: unknown) => error);
    expect(unavailable).toMatchObject({ code: 'GEO_SERVICE_UNAVAILABLE' });
    expect((unavailable as { getStatus(): number }).getStatus()).toBe(503);
    expect(JSON.stringify((unavailable as { getResponse(): unknown }).getResponse())).not.toContain(
      'raw_provider_error',
    );
    expect(attempts).toBe(1);
  });
});

function createAdapter(
  baseUrl: string,
  overrides: Partial<{
    authHeader: string;
    connectTimeoutMs: number;
    totalTimeoutMs: number;
    retryAttempts: number;
    retryDelayMs: number;
    breakerFailureThreshold: number;
    breakerOpenMs: number;
  }> = {},
): GeoServiceAdapter {
  return new GeoServiceAdapter(
    new ConfigService({
      geoService: {
        baseUrl,
        connectTimeoutMs: 100,
        totalTimeoutMs: 500,
        retryAttempts: 2,
        retryDelayMs: 1,
        breakerFailureThreshold: 5,
        breakerOpenMs: 1000,
        ...overrides,
      },
    }),
  );
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
