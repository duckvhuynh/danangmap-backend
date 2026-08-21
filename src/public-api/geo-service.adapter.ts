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

const ALLOWED_PATHS = {
  autocomplete: '/api/v1/geoservice/place:autocomplete',
  textSearch: '/api/v1/geoservice/place:textsearch',
  details: '/api/v1/geoservice/place:details',
} as const;

const locationSchema = z.object({ lat: z.coerce.number(), lng: z.coerce.number() }).passthrough();
const candidateSchema = z
  .object({
    place_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    formatted_address: z.string().optional(),
    rating: z.coerce.number().optional(),
    score: z.coerce.number().optional(),
    geometry: z.object({ location: locationSchema.optional() }).passthrough().optional(),
  })
  .passthrough();
const searchResponseSchema = z
  .object({
    predictions: z.array(candidateSchema).optional(),
    results: z.array(candidateSchema).optional(),
    candidates: z.array(candidateSchema).optional(),
  })
  .passthrough();
const detailsResponseSchema = z
  .object({
    result: candidateSchema.optional(),
  })
  .passthrough();

@Injectable()
export class GeoServiceAdapter {
  private readonly baseUrl: string;
  private readonly totalTimeoutMs: number;
  private readonly authHeader?: string;
  private consecutiveFailures = 0;
  private openedUntil = 0;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('geoService.baseUrl').replace(/\/$/, '');
    this.totalTimeoutMs = config.getOrThrow<number>('geoService.totalTimeoutMs');
    this.authHeader = config.get<string>('geoService.authHeader');
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async autocomplete(input: string, bias?: GeoBias): Promise<ExternalPlaceCandidate[]> {
    return this.search('autocomplete', { input, ...this.biasQuery(bias) });
  }

  async textSearch(query: string, bias?: GeoBias): Promise<ExternalPlaceCandidate[]> {
    return this.search('textSearch', { query, ...this.biasQuery(bias) });
  }

  async placeDetails(placeId: string, fields: string[]): Promise<ExternalPlaceDetails> {
    const payload = await this.request(ALLOWED_PATHS.details, {
      place_id: placeId,
      fields: fields.join(','),
    });
    const parsed = detailsResponseSchema.parse(payload);
    const source = parsed.result ?? candidateSchema.parse(payload);
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
    const parsed = searchResponseSchema.parse(await this.request(ALLOWED_PATHS[operation], query));
    return (parsed.predictions ?? parsed.results ?? parsed.candidates ?? [])
      .map((candidate) => ({
        id: candidate.place_id ?? candidate.id ?? '',
        title: candidate.name ?? candidate.description ?? 'Địa điểm',
        subtitle: candidate.formatted_address ?? candidate.description ?? null,
        position: this.position(candidate),
        score: Math.max(0, Math.min(1, candidate.score ?? (candidate.rating ?? 0) / 5)),
      }))
      .filter((candidate) => candidate.id.length > 0);
  }

  private async request(
    path: (typeof ALLOWED_PATHS)[keyof typeof ALLOWED_PATHS],
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    if (!this.configured || Date.now() < this.openedUntil)
      throw new Error('GEO_SERVICE_UNAVAILABLE');
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: this.authHeader ? { Authorization: this.authHeader } : undefined,
          signal: AbortSignal.timeout(this.totalTimeoutMs),
        });
        if (!response.ok) {
          if (response.status < 500 || attempt === 1) throw new Error('GEO_SERVICE_BAD_RESPONSE');
          continue;
        }
        const payload: unknown = await response.json();
        this.consecutiveFailures = 0;
        return payload;
      } catch (error) {
        lastError = error;
        if (attempt === 0) continue;
      }
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 5) this.openedUntil = Date.now() + 30_000;
    throw lastError instanceof Error ? lastError : new Error('GEO_SERVICE_UNAVAILABLE');
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
