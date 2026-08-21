import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { IMPORT_INSPECT_JOB, IMPORT_QUEUE } from '../jobs/jobs.constants';
import { StorageService } from '../storage/storage.service';
import { MAX_IMPORT_BYTES } from './import-file.inspector';
import { ImportJobEntity } from './import.entity';

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
    if (!record || !['uploaded', 'inspecting'].includes(record.status)) return;
    await this.imports.update(record.id, { status: 'inspecting', progress: 10, failureCode: null });
    try {
      const stat = await this.storage.stat(record.objectKey);
      if (stat.size !== record.sizeBytes || stat.size < 1 || stat.size > MAX_IMPORT_BYTES) {
        throw new Error('IMPORT_OBJECT_SIZE_MISMATCH');
      }
      await this.imports.update(record.id, {
        status: 'mapping_required',
        progress: 100,
        mapping: {
          ...record.mapping,
          inspection: {
            maxRecords: 100_000,
            maxVerticesPerFeature: 100_000,
            maxVerticesPerJob: 2_000_000,
            maxExpandedBytes: 250 * 1024 * 1024,
            maxIssues: 20_000,
          },
        },
      });
    } catch (error) {
      await this.imports.update(record.id, {
        status: 'failed',
        failureCode: error instanceof Error ? error.message.slice(0, 100) : 'IMPORT_INSPECT_FAILED',
      });
      throw error;
    }
  }
}
