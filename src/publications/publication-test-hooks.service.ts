import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  PublicationInjectedRetryError,
  PublicationInjectedTerminalError,
} from './publication-worker.errors';

export type PublicationTestPoint =
  'before_first_batch' | 'after_batch_commit' | 'before_pointer_switch' | 'after_final_commit';

@Injectable()
export class PublicationTestHooksService {
  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async checkpoint(point: PublicationTestPoint, jobId: string): Promise<void> {
    if (this.config.getOrThrow<string>('app.environment') !== 'test') return;
    if (this.config.get<string>('publication.testBarrier') === point) {
      await this.waitForAdvisoryBarrier(point, jobId);
    }
    if (this.config.get<string>('publication.testFailpoint') !== point) return;
    if (point === 'before_pointer_switch') throw new PublicationInjectedTerminalError(point);
    throw new PublicationInjectedRetryError(point);
  }

  barrierKey(point: PublicationTestPoint, jobId: string): string {
    return `danangmap:publication:test:${point}:${jobId}`;
  }

  private async waitForAdvisoryBarrier(point: PublicationTestPoint, jobId: string): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    const key = this.barrierKey(point, jobId);
    try {
      await runner.query(`SELECT pg_advisory_lock(hashtextextended($1,0))`, [key]);
    } finally {
      await runner
        .query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [key])
        .catch(() => []);
      await runner.release();
    }
  }
}
