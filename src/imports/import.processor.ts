import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { IMPORT_INSPECT_JOB, IMPORT_QUEUE } from '../jobs/jobs.constants';
import { StorageService } from '../storage/storage.service';
import { MAX_IMPORT_BYTES } from './import-file.inspector';
import { ImportJobEntity } from './import.entity';

const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_VERTICES_PER_FEATURE = 100_000;
const MAX_VERTICES_PER_JOB = 2_000_000;
const GEOJSON_GEOMETRY_TYPES = new Set([
  'GeometryCollection',
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

type InspectionFailureCode =
  | 'IMPORT_OBJECT_SIZE_MISMATCH'
  | 'IMPORT_OBJECT_TOO_LARGE'
  | 'XLSX_INVALID'
  | 'XLSX_ZIP64_UNSUPPORTED'
  | 'IMPORT_EXPANDED_SIZE_LIMIT'
  | 'GEOJSON_INVALID'
  | 'IMPORT_RECORD_LIMIT'
  | 'IMPORT_FEATURE_VERTEX_LIMIT'
  | 'IMPORT_VERTEX_LIMIT';

class ImportInspectionError extends Error {
  constructor(readonly code: InspectionFailureCode) {
    super(code);
  }
}

@Processor(IMPORT_QUEUE, { concurrency: 2 })
export class ImportProcessor extends WorkerHost {
  constructor(
    @InjectRepository(ImportJobEntity) private readonly imports: Repository<ImportJobEntity>,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<{ importId: string }>): Promise<void> {
    if (job.name !== IMPORT_INSPECT_JOB) return;
    const record = await this.imports.findOneBy({ id: job.data.importId });
    const isRetryableFailure =
      record?.status === 'failed' && record.failureCode === 'IMPORT_INSPECT_FAILED';
    if (!record || (!['uploaded', 'inspecting'].includes(record.status) && !isRetryableFailure)) {
      return;
    }
    await this.imports.update(record.id, { status: 'inspecting', progress: 10, failureCode: null });
    try {
      const stat = await this.storage.stat(record.objectKey);
      if (stat.size !== record.sizeBytes || stat.size < 1) {
        throw new ImportInspectionError('IMPORT_OBJECT_SIZE_MISMATCH');
      }
      if (stat.size > MAX_IMPORT_BYTES) throw new ImportInspectionError('IMPORT_OBJECT_TOO_LARGE');
      const content = await this.readBounded(record.objectKey);
      const counts = record.format === 'geojson' ? this.inspectGeoJson(content) : {};
      if (record.format === 'xlsx') this.enforceZipExpansion(content);
      await this.imports.update(record.id, {
        status: 'mapping_required',
        progress: 100,
        counts,
        mapping: {
          ...record.mapping,
          inspection: {
            parserStatus: ['csv', 'kml'].includes(record.format) ? 'mapping_skeleton' : 'inspected',
            maxRecords: MAX_RECORDS,
            maxVerticesPerFeature: MAX_VERTICES_PER_FEATURE,
            maxVerticesPerJob: MAX_VERTICES_PER_JOB,
            maxExpandedBytes: MAX_EXPANDED_BYTES,
            maxIssues: 20_000,
          },
        },
      });
    } catch (error) {
      const failureCode =
        error instanceof ImportInspectionError ? error.code : 'IMPORT_INSPECT_FAILED';
      await this.imports.update(record.id, { status: 'failed', failureCode });
      if (error instanceof ImportInspectionError) throw new UnrecoverableError(error.code);
      throw error;
    }
  }

  private async readBounded(key: string): Promise<Buffer> {
    const stream = await this.storage.getObject(key);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_IMPORT_BYTES) {
        stream.destroy();
        throw new ImportInspectionError('IMPORT_OBJECT_TOO_LARGE');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }

  private enforceZipExpansion(content: Buffer): void {
    let offset = 0;
    let entries = 0;
    let expandedBytes = 0;
    while (offset + 46 <= content.byteLength) {
      if (content.readUInt32LE(offset) !== 0x02014b50) {
        offset += 1;
        continue;
      }
      const uncompressed = content.readUInt32LE(offset + 24);
      if (uncompressed === 0xffffffff) throw new ImportInspectionError('XLSX_ZIP64_UNSUPPORTED');
      expandedBytes += uncompressed;
      if (expandedBytes > MAX_EXPANDED_BYTES) {
        throw new ImportInspectionError('IMPORT_EXPANDED_SIZE_LIMIT');
      }
      const nameLength = content.readUInt16LE(offset + 28);
      const extraLength = content.readUInt16LE(offset + 30);
      const commentLength = content.readUInt16LE(offset + 32);
      entries += 1;
      offset += 46 + nameLength + extraLength + commentLength;
    }
    if (entries === 0) throw new ImportInspectionError('XLSX_INVALID');
  }

  private inspectGeoJson(content: Buffer): Record<string, number> {
    let payload: unknown;
    try {
      payload = JSON.parse(content.toString('utf8'));
    } catch {
      throw new ImportInspectionError('GEOJSON_INVALID');
    }
    const features = this.features(payload);
    if (features.length > MAX_RECORDS) throw new ImportInspectionError('IMPORT_RECORD_LIMIT');
    let vertices = 0;
    for (const feature of features) {
      const featureVertices = this.countGeometryVertices(feature);
      if (featureVertices > MAX_VERTICES_PER_FEATURE) {
        throw new ImportInspectionError('IMPORT_FEATURE_VERTEX_LIMIT');
      }
      vertices += featureVertices;
      if (vertices > MAX_VERTICES_PER_JOB) throw new ImportInspectionError('IMPORT_VERTEX_LIMIT');
    }
    return { total: features.length, vertices };
  }

  private features(value: unknown): unknown[] {
    if (!value || typeof value !== 'object') throw new ImportInspectionError('GEOJSON_INVALID');
    const record = value as { type?: unknown; features?: unknown };
    if (record.type === 'FeatureCollection') {
      if (!Array.isArray(record.features)) throw new ImportInspectionError('GEOJSON_INVALID');
      return record.features;
    }
    if (record.type === 'Feature' || GEOJSON_GEOMETRY_TYPES.has(String(record.type)))
      return [value];
    throw new ImportInspectionError('GEOJSON_INVALID');
  }

  private countGeometryVertices(value: unknown): number {
    if (!value || typeof value !== 'object') return 0;
    const record = value as { geometry?: unknown; geometries?: unknown; coordinates?: unknown };
    if (record.geometry) return this.countGeometryVertices(record.geometry);
    if (Array.isArray(record.geometries)) {
      let total = 0;
      for (const geometry of record.geometries as unknown[]) {
        total += this.countGeometryVertices(geometry);
      }
      return total;
    }
    return this.countCoordinates(record.coordinates);
  }

  private countCoordinates(value: unknown): number {
    if (!Array.isArray(value)) return 0;
    if (value.length >= 2 && value.every((coordinate) => typeof coordinate === 'number')) return 1;
    let total = 0;
    for (const item of value as unknown[]) total += this.countCoordinates(item);
    return total;
  }
}
