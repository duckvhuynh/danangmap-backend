import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { PUBLICATION_BUILD_JOB, PUBLICATION_QUEUE } from '../jobs/jobs.constants';
import { PublicationJobRepository } from './publication-job.repository';
import { PublicationWorkerRepository } from './publication-worker.repository';

@Injectable()
export class PublicationRecoveryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PublicationRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @InjectQueue(PUBLICATION_QUEUE) private readonly queue: Queue,
    private readonly jobs: PublicationJobRepository,
    private readonly worker: PublicationWorkerRepository,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.runScheduled();
    this.timer = setInterval(
      () => this.runScheduled(),
      this.config.getOrThrow<number>('publication.recoveryIntervalMs'),
    );
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async recoverOnce(): Promise<void> {
    const expired = await this.worker.requeueExpiredLeases();
    const candidates = await this.jobs.queuedForReconciliation(
      this.config.getOrThrow<number>('publication.dispatchBatchSize') * 4,
    );
    const ids = new Map(candidates.map((candidate) => [candidate.id, candidate.payloadVersion]));
    for (const id of expired) ids.set(id, 1);
    for (const [publicationJobId, payloadVersion] of ids) {
      await this.ensureDelivery(publicationJobId, payloadVersion);
    }
    await this.worker.workerHeartbeat();
    if (expired.length > 0) {
      this.logger.warn(
        JSON.stringify({ event: 'publication.expired_leases_recovered', count: expired.length }),
      );
    }
  }

  private runScheduled(): void {
    if (this.stopping || this.running) return;
    this.running = this.recoverOnce()
      .catch(async () => {
        await this.worker
          .workerHeartbeat('PUBLICATION_DEPENDENCY_UNAVAILABLE')
          .catch(() => undefined);
        this.logger.error(
          JSON.stringify({
            event: 'publication.recovery_sweep_failed',
            code: 'PUBLICATION_DEPENDENCY_UNAVAILABLE',
          }),
        );
      })
      .finally(() => {
        this.running = null;
      });
  }

  private async ensureDelivery(publicationJobId: string, payloadVersion: number): Promise<void> {
    const bullJobId = `publication-${publicationJobId}`;
    let existing = await this.queue.getJob(bullJobId);
    if (existing && ['completed', 'failed', 'delayed'].includes(await existing.getState())) {
      await existing.remove();
      existing = undefined;
    }
    if (existing) return;
    await this.queue.add(
      PUBLICATION_BUILD_JOB,
      { publicationJobId, payloadVersion },
      {
        jobId: bullJobId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
  }
}
