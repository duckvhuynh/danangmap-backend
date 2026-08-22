import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { MAIL_DELIVER_JOB, MAIL_QUEUE, MAIL_SWEEP_JOB } from '../jobs/jobs.constants';
import { MailDeliveryService } from './mail-delivery.service';

interface MailJobData {
  outboxId?: string;
}

@Processor(MAIL_QUEUE, { concurrency: 2 })
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(
    private readonly delivery: MailDeliveryService,
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<MailJobData>): Promise<void> {
    if (job.name === MAIL_SWEEP_JOB) {
      await this.runSweep();
      return;
    }
    if (job.name === MAIL_DELIVER_JOB && job.data.outboxId) {
      await this.delivery.deliver(job.data.outboxId);
    }
  }

  private async runSweep(): Promise<void> {
    try {
      const result = await this.delivery.sweep();
      await Promise.all(
        result.due.map(({ id, attempt }) =>
          this.queue.add(
            MAIL_DELIVER_JOB,
            { outboxId: id },
            {
              jobId: `mail-${id}-${attempt}`,
              removeOnComplete: true,
              removeOnFail: true,
              attempts: 1,
            },
          ),
        ),
      );
    } catch {
      await this.delivery.updateState('degraded', 'MAIL_SMTP_UNREACHABLE').catch(() => undefined);
      this.logger.error(JSON.stringify({ event: 'mail.sweep_failed', code: 'MAIL_SWEEP_FAILED' }));
    }
  }
}
