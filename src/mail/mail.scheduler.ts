import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { MAIL_QUEUE, MAIL_SWEEP_JOB, MAIL_SWEEP_SCHEDULER } from '../jobs/jobs.constants';

@Injectable()
export class MailScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      MAIL_SWEEP_SCHEDULER,
      { every: this.config.getOrThrow<number>('mail.sweepIntervalMs') },
      {
        name: MAIL_SWEEP_JOB,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 20, attempts: 1 },
      },
    );
  }
}
