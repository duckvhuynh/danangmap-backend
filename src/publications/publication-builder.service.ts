import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../common/crypto/crypto.service';
import { DataSource } from 'typeorm';
import { PublicationActivationService } from './publication-activation.service';
import { PublicationFingerprintService } from './publication-fingerprint.service';
import { PublicationTestHooksService } from './publication-test-hooks.service';
import { PublicationBuildError } from './publication-worker.errors';
import {
  type PublicationBuildJob,
  type PublicationBuildContext,
  PublicationLeaseLostError,
  PublicationWorkerRepository,
  type PublicProjectionRow,
} from './publication-worker.repository';

@Injectable()
export class PublicationBuilderService {
  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly activation: PublicationActivationService,
    private readonly fingerprint: PublicationFingerprintService,
    private readonly hooks: PublicationTestHooksService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async build(
    job: PublicationBuildJob & { leaseToken: string },
  ): Promise<{ activated: boolean; snapshotId: string | null; generation: number | null }> {
    const leaseSeconds = this.config.getOrThrow<number>('publication.buildLeaseSeconds');
    const context = await this.repository.context(job.id, job.leaseToken);
    if (!context) throw new PublicationLeaseLostError();
    await this.validate(job, context);

    const total = context.featureCount;
    if (job.featureTotal === null) {
      await this.repository.setPrepared(job.id, job.leaseToken, total, leaseSeconds);
    } else if (job.featureTotal !== total) {
      throw new PublicationBuildError('PUBLICATION_INPUT_INVALID');
    }

    let checkpoint = await this.repository.checkpoint(job.id);
    let processed = job.featureProcessed;
    if (!checkpoint && total > 0) {
      await this.hooks.checkpoint('before_first_batch', job.id);
    }
    while (processed < total) {
      const rows = await this.repository.publicBatch(
        job.revisionId,
        checkpoint?.lastFeatureId ?? null,
        this.config.getOrThrow<number>('publication.buildBatchSize'),
      );
      if (rows.length === 0) throw new PublicationBuildError('PUBLICATION_INPUT_INVALID');
      const projection = rows.map((row) => this.projection(row));
      if (Buffer.byteLength(JSON.stringify(projection), 'utf8') > 16 * 1024 * 1024) {
        throw new PublicationBuildError('PUBLICATION_BUILD_LIMIT_EXCEEDED');
      }
      const batchNo = (checkpoint?.batchNo ?? 0) + 1;
      const bounds = this.bounds(rows);
      const progress = await this.repository.commitBatch({
        jobId: job.id,
        leaseToken: job.leaseToken,
        batchNo,
        firstFeatureId: rows[0]!.featureId,
        lastFeatureId: rows.at(-1)!.featureId,
        featureCount: rows.length,
        vertexCount: rows.reduce((sum, row) => sum + row.vertexCount, 0),
        bounds,
        checksum: this.crypto.checksum(JSON.stringify(projection)),
        projection,
        leaseSeconds,
      });
      processed = progress.processed;
      checkpoint = { batchNo, lastFeatureId: rows.at(-1)!.featureId };
      await this.hooks.checkpoint('after_batch_commit', job.id);
    }

    const batchChecksums = await this.repository.batchChecksums(job.id);
    const buildChecksum = this.crypto.checksum(batchChecksums.join(''));
    const manifest = {
      sourceKind: 'geojson',
      sourceLayer: 'features',
      schemaVersion: job.revisionSchemaVersion,
      projectionVersion: 1,
      batchCount: batchChecksums.length,
      featureCount: total,
      vertexCount: context.vertexCount,
      publicFieldKeys: context.publicFieldKeys,
      attachmentProjection: 'unavailable',
    };
    await this.repository.markSwitching(
      job.id,
      job.leaseToken,
      buildChecksum,
      manifest,
      leaseSeconds,
    );
    await this.hooks.checkpoint('before_pointer_switch', job.id);
    const result = await this.activation.activate(job.id, job.leaseToken);
    if (result.activated) await this.hooks.checkpoint('after_final_commit', job.id);
    return result;
  }

  private async validate(
    job: PublicationBuildJob,
    context: PublicationBuildContext,
  ): Promise<void> {
    if (
      context.actorStatus !== 'active' ||
      context.actorRole !== 'publisher' ||
      context.actorDisabledAt !== null
    ) {
      throw new PublicationBuildError('PUBLICATION_ACTOR_INELIGIBLE');
    }
    if (context.editorialParticipant) {
      throw new PublicationBuildError('PUBLICATION_SEPARATION_OF_DUTIES');
    }
    if (
      context.revisionStatus !== 'publishing' ||
      context.revisionLockVersion !== job.revisionLockVersion ||
      context.revisionSchemaVersion !== job.revisionSchemaVersion ||
      (await this.fingerprint.calculate(this.dataSource.manager, job.revisionId)) !==
        job.revisionFingerprint
    ) {
      throw new PublicationBuildError('PUBLICATION_INPUT_INVALID');
    }
    if (
      context.activeSnapshotId !== job.expectedActiveSnapshotId ||
      context.activeGeneration !== job.expectedActiveGeneration
    ) {
      throw new PublicationBuildError('PUBLICATION_BASE_STALE');
    }
    if (context.invalidFeatureCount > 0 || context.missingRequiredCount > 0) {
      throw new PublicationBuildError('PUBLICATION_INPUT_INVALID');
    }
    if (
      context.featureCount > this.config.getOrThrow<number>('publication.maxFeatures') ||
      context.vertexCount > this.config.getOrThrow<number>('publication.maxVertices')
    ) {
      throw new PublicationBuildError('PUBLICATION_BUILD_LIMIT_EXCEEDED');
    }
  }

  private projection(row: PublicProjectionRow): Record<string, unknown> {
    return {
      type: 'Feature',
      id: row.featureId,
      geometry: row.geometry,
      properties: row.properties,
      geometryKind: row.geometryKind,
      radiusM: row.radiusM,
    };
  }

  private bounds(rows: PublicProjectionRow[]): [number, number, number, number] | null {
    if (rows.length === 0) return null;
    return [
      Math.min(...rows.map((row) => row.bounds[0])),
      Math.min(...rows.map((row) => row.bounds[1])),
      Math.max(...rows.map((row) => row.bounds[2])),
      Math.max(...rows.map((row) => row.bounds[3])),
    ];
  }
}
