import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PUBLICATION_BUILD_JOB, PUBLICATION_QUEUE } from '../jobs/jobs.constants';
import {
  PublicationActivationInvariantError,
  PublicationActivationService,
} from './publication-activation.service';
import { PublicationBuilderService } from './publication-builder.service';
import { PublicationBuildError, PublicationInjectedRetryError } from './publication-worker.errors';
import {
  PublicationLeaseLostError,
  PublicationWorkerRepository,
} from './publication-worker.repository';

interface PublicationQueueData {
  publicationJobId: string;
  payloadVersion: number;
}

@Injectable()
@Processor(PUBLICATION_QUEUE, { concurrency: 2 })
export class PublicationProcessor extends WorkerHost implements OnApplicationShutdown {
  private readonly logger = new Logger(PublicationProcessor.name);
  private readonly owner = `publication-worker-${process.pid}-${randomUUID()}`;
  private draining = false;

  constructor(
    private readonly repository: PublicationWorkerRepository,
    private readonly builder: PublicationBuilderService,
    private readonly activation: PublicationActivationService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  onApplicationShutdown(): void {
    this.draining = true;
  }

  async process(job: Job<PublicationQueueData>): Promise<void> {
    if (job.name !== PUBLICATION_BUILD_JOB) return;
    if (this.draining) throw new Error('PUBLICATION_WORKER_DRAINING');
    if (!this.validData(job.data)) throw new UnrecoverableError('PUBLICATION_JOB_PAYLOAD_INVALID');

    const jobId = job.data.publicationJobId;
    const claim = await this.repository.claim(
      jobId,
      this.owner,
      this.config.getOrThrow<number>('publication.buildLeaseSeconds'),
    );
    if (claim.kind === 'missing' || claim.kind === 'terminal' || claim.kind === 'busy') {
      this.log('publication.delivery_noop', jobId, { reason: claim.kind });
      return;
    }
    if (claim.kind === 'exhausted') {
      await this.activation.fail(jobId, null, 'PUBLICATION_RETRY_EXHAUSTED', randomUUID());
      this.log('publication.job_failed', jobId, { code: 'PUBLICATION_RETRY_EXHAUSTED' });
      return;
    }

    const heartbeat = this.startHeartbeat(jobId, claim.job.leaseToken);
    this.log('publication.job_started', jobId, { attempt: claim.job.attempts });
    try {
      const result = await this.builder.build(claim.job);
      this.log(
        result.activated ? 'publication.job_succeeded' : 'publication.delivery_noop',
        jobId,
        {
          generation: result.generation,
        },
      );
    } catch (error) {
      if (error instanceof PublicationLeaseLostError) {
        this.log('publication.lease_lost', jobId);
        return;
      }
      if (
        error instanceof PublicationBuildError ||
        error instanceof PublicationActivationInvariantError
      ) {
        await this.activation.fail(jobId, claim.job.leaseToken, error.code, randomUUID());
        this.log('publication.job_failed', jobId, { code: error.code });
        return;
      }
      if (error instanceof PublicationInjectedRetryError && error.point === 'after_final_commit') {
        this.log('publication.test_crash_after_commit', jobId);
        throw new Error('PUBLICATION_DEPENDENCY_UNAVAILABLE', { cause: error });
      }

      const exhausted = claim.job.attempts >= claim.job.maxAttempts;
      if (exhausted) {
        await this.activation.fail(
          jobId,
          claim.job.leaseToken,
          'PUBLICATION_RETRY_EXHAUSTED',
          randomUUID(),
        );
        this.log('publication.job_failed', jobId, { code: 'PUBLICATION_RETRY_EXHAUSTED' });
        return;
      }
      const delay = Math.min(
        60_000,
        this.config.getOrThrow<number>('publication.retryBackoffMs') *
          2 ** Math.min(claim.job.attempts - 1, 8),
      );
      await this.repository.releaseForRetry(jobId, claim.job.leaseToken, delay);
      this.log('publication.job_retry_scheduled', jobId, {
        attempt: claim.job.attempts,
        delayMilliseconds: delay,
      });
      throw new Error('PUBLICATION_DEPENDENCY_UNAVAILABLE', { cause: error });
    } finally {
      await heartbeat.stop();
    }
  }

  private startHeartbeat(jobId: string, leaseToken: string): { stop: () => Promise<void> } {
    const interval = this.config.getOrThrow<number>('publication.heartbeatIntervalMs');
    let running: Promise<boolean> | null = null;
    const timer = setInterval(() => {
      if (running) return;
      running = this.repository
        .heartbeat(
          jobId,
          leaseToken,
          this.config.getOrThrow<number>('publication.buildLeaseSeconds'),
        )
        .catch(() => false)
        .finally(() => {
          running = null;
        });
    }, interval);
    timer.unref();
    return {
      stop: async () => {
        clearInterval(timer);
        await running;
      },
    };
  }

  private validData(data: PublicationQueueData): boolean {
    return (
      data?.payloadVersion === 1 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        data.publicationJobId,
      )
    );
  }

  private log(event: string, publicationJobId: string, fields: Record<string, unknown> = {}): void {
    this.logger.log(JSON.stringify({ event, publicationJobId, ...fields }));
  }
}
