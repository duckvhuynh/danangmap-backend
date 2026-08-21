import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PUBLICATION_BUILD_JOB, PUBLICATION_QUEUE } from '../jobs/jobs.constants';
import { PublicationJobRepository } from './publication-job.repository';

const SAFE_QUEUE_ERROR = 'PUBLICATION_QUEUE_UNAVAILABLE';

@Injectable()
export class PublicationOutboxService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PublicationOutboxService.name);
  private readonly owner = `api-${process.pid}-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @InjectQueue(PUBLICATION_QUEUE) private readonly queue: Queue,
    private readonly repository: PublicationJobRepository,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.config.getOrThrow<boolean>('publication.asyncEnabled')) return;
    const interval = this.config.getOrThrow<number>('publication.dispatchIntervalMs');
    this.runScheduled();
    this.timer = setInterval(() => this.runScheduled(), interval);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async dispatchOnce(): Promise<void> {
    const batchSize = this.config.getOrThrow<number>('publication.dispatchBatchSize');
    const leaseSeconds = this.config.getOrThrow<number>('publication.outboxLeaseSeconds');
    try {
      const claims = await this.repository.claimOutbox(batchSize, this.owner, leaseSeconds);
      for (const claim of claims) {
        try {
          await this.addJob(claim.publicationJobId, claim.payloadVersion);
          await this.repository.markOutboxDispatched(claim.id, claim.leaseToken);
        } catch {
          const delaySeconds = Math.min(300, 2 ** Math.min(claim.attempts, 8));
          await this.repository
            .releaseOutboxClaim(claim.id, claim.leaseToken, delaySeconds, SAFE_QUEUE_ERROR)
            .catch(() => undefined);
          this.logger.warn(
            JSON.stringify({
              event: 'publication.outbox_dispatch_failed',
              code: SAFE_QUEUE_ERROR,
              publicationJobId: claim.publicationJobId,
            }),
          );
        }
      }

      const reconciliation = await this.repository.queuedForReconciliation(batchSize * 4);
      for (const job of reconciliation) {
        const bullJobId = this.bullJobId(job.id);
        if (!(await this.queue.getJob(bullJobId))) {
          await this.addJob(job.id, job.payloadVersion);
          this.logger.log(
            JSON.stringify({
              event: 'publication.queue_reconciled',
              publicationJobId: job.id,
            }),
          );
        }
      }
      await this.repository.updateDispatchState(null);
    } catch {
      await this.repository.updateDispatchState(SAFE_QUEUE_ERROR).catch(() => undefined);
      this.logger.error(
        JSON.stringify({ event: 'publication.dispatch_sweep_failed', code: SAFE_QUEUE_ERROR }),
      );
    }
  }

  private runScheduled(): void {
    if (this.stopping || this.running) return;
    this.running = this.dispatchOnce().finally(() => {
      this.running = null;
    });
  }

  private async addJob(publicationJobId: string, payloadVersion: number): Promise<void> {
    await this.queue.add(
      PUBLICATION_BUILD_JOB,
      { publicationJobId, payloadVersion },
      {
        jobId: this.bullJobId(publicationJobId),
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
  }

  private bullJobId(publicationJobId: string): string {
    return `publication-${publicationJobId}`;
  }
}
