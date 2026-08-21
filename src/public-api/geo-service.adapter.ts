import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

export interface GeoBias {
  latitude: number;
  longitude: number;
  radiusM?: number;
}

export interface ExternalPlaceCandidate {
  id: string;
  title: string;
  subtitle: string | null;
  position: { longitude: number; latitude: number } | null;
  score: number;
}

export interface ExternalPlaceDetails {
  id: string;
  name: string;
  address: string | null;
  position: { longitude: number; latitude: number } | null;
  phone: string | null;
  website: string | null;
}

export class GeoServiceUnavailableError extends Error {
  readonly code = 'GEO_SERVICE_UNAVAILABLE';

  constructor() {
    super('Geo Service is unavailable.');
    this.name = 'GeoServiceUnavailableError';
  }
}

const ALLOWED_PATHS = {
  autocomplete: '/api/v1/geoservice/place:autocomplete',
  textSearch: '/api/v1/geoservice/place:textsearch',
  details: '/api/v1/geoservice/place:details',
} as const;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const numericValue = z.union([
  z.number(),
  z
    .string()
    .trim()
    .regex(/^-?(?:\d+\.?\d*|\.\d+)$/)
    .transform(Number),
]);
const latitude = numericValue.pipe(z.number().finite().min(-90).max(90));
const longitude = numericValue.pipe(z.number().finite().min(-180).max(180));
const locationSchema = z.object({ lat: latitude, lng: longitude }).passthrough();
const candidateSchema = z
  .object({
    place_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    formatted_address: z.string().optional(),
    rating: numericValue.pipe(z.number().finite()).optional(),
    score: numericValue.pipe(z.number().finite()).optional(),
    geometry: z.object({ location: locationSchema.optional() }).passthrough().optional(),
  })
  .passthrough()
  .refine(
    (candidate) =>
      candidate.place_id !== undefined ||
      candidate.id !== undefined ||
      candidate.name !== undefined ||
      candidate.description !== undefined ||
      candidate.formatted_address !== undefined ||
      candidate.geometry !== undefined,
    { message: 'Candidate contains no recognized fields.' },
  );
const searchResponseSchema = z
  .object({
    predictions: z.array(candidateSchema).max(100).optional(),
    results: z.array(candidateSchema).max(100).optional(),
    candidates: z.array(candidateSchema).max(100).optional(),
  })
  .passthrough()
  .refine(
    (response) =>
      response.predictions !== undefined ||
      response.results !== undefined ||
      response.candidates !== undefined,
    { message: 'Search response contains no result collection.' },
  );
const detailsResponseSchema = z
  .object({
    result: candidateSchema.optional(),
  })
  .passthrough();

class ProviderRequestFailure extends Error {
  constructor(readonly retryable: boolean) {
    super('Geo Service provider request failed.');
  }
}

@Injectable()
export class GeoServiceAdapter {
  private readonly baseUrl: string;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly breakerFailureThreshold: number;
  private readonly breakerOpenMs: number;
  private readonly authHeader?: string;
  private consecutiveFailures = 0;
  private openedUntil = 0;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('geoService.baseUrl').replace(/\/$/, '');
    this.connectTimeoutMs = config.getOrThrow<number>('geoService.connectTimeoutMs');
    this.totalTimeoutMs = config.getOrThrow<number>('geoService.totalTimeoutMs');
    this.retryAttempts = config.getOrThrow<number>('geoService.retryAttempts');
    this.retryDelayMs = config.getOrThrow<number>('geoService.retryDelayMs');
    this.breakerFailureThreshold = config.getOrThrow<number>('geoService.breakerFailureThreshold');
    this.breakerOpenMs = config.getOrThrow<number>('geoService.breakerOpenMs');
    this.authHeader = config.get<string>('geoService.authHeader');
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  get healthStatus(): 'up' | 'degraded' {
    return this.configured && this.consecutiveFailures < this.breakerFailureThreshold
      ? 'up'
      : 'degraded';
  }

  async autocomplete(input: string, bias?: GeoBias): Promise<ExternalPlaceCandidate[]> {
    return this.search('autocomplete', { input, ...this.biasQuery(bias) });
  }

  async textSearch(query: string, bias?: GeoBias): Promise<ExternalPlaceCandidate[]> {
    return this.search('textSearch', { query, ...this.biasQuery(bias) });
  }

  async placeDetails(placeId: string, fields: string[]): Promise<ExternalPlaceDetails> {
    const payload = await this.execute(ALLOWED_PATHS.details, {
      place_id: placeId,
      fields: fields.join(','),
    });
    const parsed = detailsResponseSchema.safeParse(payload);
    if (!parsed.success) return this.failSchema();
    const direct = candidateSchema.safeParse(payload);
    const source = parsed.data.result ?? (direct.success ? direct.data : undefined);
    if (!source) return this.failSchema();
    this.recordSuccess();
    return {
      id: source.place_id ?? source.id ?? placeId,
      name: source.name ?? source.description ?? 'Địa điểm',
      address: source.formatted_address ?? source.description ?? null,
      position: this.position(source),
      phone: this.stringField(source, 'formatted_phone_number'),
      website: this.stringField(source, 'website'),
    };
  }

  private async search(
    operation: 'autocomplete' | 'textSearch',
    query: Record<string, string | number | undefined>,
  ): Promise<ExternalPlaceCandidate[]> {
    const payload = await this.execute(ALLOWED_PATHS[operation], query);
    const parsed = searchResponseSchema.safeParse(payload);
    if (!parsed.success) return this.failSchema();
    this.recordSuccess();
    return (parsed.data.predictions ?? parsed.data.results ?? parsed.data.candidates ?? [])
      .map((candidate) => ({
        id: candidate.place_id ?? candidate.id ?? '',
        title: candidate.name ?? candidate.description ?? 'Địa điểm',
        subtitle: candidate.formatted_address ?? candidate.description ?? null,
        position: this.position(candidate),
        score: Math.max(0, Math.min(1, candidate.score ?? (candidate.rating ?? 0) / 5)),
      }))
      .filter((candidate) => candidate.id.length > 0);
  }

  private async execute(
    path: (typeof ALLOWED_PATHS)[keyof typeof ALLOWED_PATHS],
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    if (!this.configured || Date.now() < this.openedUntil) {
      throw new GeoServiceUnavailableError();
    }

    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const totalController = new AbortController();
    const totalTimer = setTimeout(() => totalController.abort(), this.totalTimeoutMs);
    try {
      for (let attempt = 0; attempt < this.retryAttempts; attempt += 1) {
        try {
          return await this.fetchJson(url, totalController.signal);
        } catch (error) {
          const retryable =
            error instanceof ProviderRequestFailure
              ? error.retryable
              : !totalController.signal.aborted;
          if (!retryable || attempt + 1 >= this.retryAttempts || totalController.signal.aborted) {
            throw error;
          }
          await this.delay(this.retryDelayMs * 2 ** attempt, totalController.signal);
        }
      }
      throw new ProviderRequestFailure(false);
    } catch {
      this.recordFailure();
      throw new GeoServiceUnavailableError();
    } finally {
      clearTimeout(totalTimer);
    }
  }

  private async fetchJson(url: URL, totalSignal: AbortSignal): Promise<unknown> {
    if (totalSignal.aborted) throw new ProviderRequestFailure(false);
    const connectController = new AbortController();
    const connectTimer = setTimeout(() => connectController.abort(), this.connectTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.authHeader ? { Authorization: this.authHeader } : undefined,
        redirect: 'error',
        signal: AbortSignal.any([totalSignal, connectController.signal]),
      });
    } catch {
      throw new ProviderRequestFailure(!totalSignal.aborted);
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) {
      throw new ProviderRequestFailure(RETRYABLE_STATUSES.has(response.status));
    }
    return this.readJson(response);
  }

  private async readJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new ProviderRequestFailure(false);
    }
    if (!response.body) throw new ProviderRequestFailure(false);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new ProviderRequestFailure(false);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ProviderRequestFailure) throw error;
      throw new ProviderRequestFailure(true);
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ProviderRequestFailure(false);
    }
  }

  private async delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ProviderRequestFailure(false));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private failSchema(): never {
    this.recordFailure();
    throw new GeoServiceUnavailableError();
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.breakerFailureThreshold) {
      this.openedUntil = Date.now() + this.breakerOpenMs;
    }
  }

  private biasQuery(bias?: GeoBias): Record<string, string | number | undefined> {
    return bias ? { location: `${bias.latitude},${bias.longitude}`, radius: bias.radiusM } : {};
  }

  private position(candidate: z.infer<typeof candidateSchema>) {
    const location = candidate.geometry?.location;
    return location ? { longitude: location.lng, latitude: location.lat } : null;
  }

  private stringField(candidate: z.infer<typeof candidateSchema>, key: string): string | null {
    const value = candidate[key];
    return typeof value === 'string' ? value : null;
  }
}
