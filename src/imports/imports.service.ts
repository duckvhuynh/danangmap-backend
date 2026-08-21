import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import type { RequestWithContext } from '../common/http/request-context';
import { IMPORT_INSPECT_JOB, IMPORT_QUEUE } from '../jobs/jobs.constants';
import { requireIdempotencyKey, requireRevisionVersion } from '../layers/etag';
import { LayerRevisionEntity } from '../layers/layer.entities';
import { StorageService } from '../storage/storage.service';
import type { CreateImportDto } from './import.dto';
import { ImportFileInspector } from './import-file.inspector';
import { ImportJobEntity } from './import.entity';

@Injectable()
export class ImportsService {
  constructor(
    @InjectRepository(ImportJobEntity) private readonly jobs: Repository<ImportJobEntity>,
    @InjectRepository(LayerRevisionEntity)
    private readonly revisions: Repository<LayerRevisionEntity>,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue,
    private readonly storage: StorageService,
    private readonly inspector: ImportFileInspector,
  ) {}

  async create(
    revisionId: string,
    file: Express.Multer.File | undefined,
    dto: CreateImportDto,
    ifMatch: string | undefined,
    idempotencyHeader: string | undefined,
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    if (!file) throw new AppException(400, 'IMPORT_FILE_REQUIRED', 'Thiếu tệp import.');
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const existing = await this.jobs.findOneBy({ revisionId, idempotencyKey });
    if (existing) return this.response(existing);

    const expectedVersion = requireRevisionVersion(ifMatch, revisionId);
    const revision = await this.revisions.findOneBy({ id: revisionId });
    if (!revision) throw new AppException(404, 'REVISION_NOT_FOUND', 'Không tìm thấy revision.');
    if (revision.status !== 'draft') {
      throw new AppException(
        409,
        'REVISION_NOT_EDITABLE',
        'Revision không còn ở trạng thái draft.',
      );
    }
    if (revision.lockVersion !== expectedVersion) {
      throw new AppException(412, 'ETAG_MISMATCH', 'Revision đã thay đổi.', {
        currentEtag: `"rev-${revisionId}-v${revision.lockVersion}"`,
      });
    }
    const activeJobs = await this.jobs.count({
      where: [
        { actorId: actor.id, status: 'uploaded' },
        { actorId: actor.id, status: 'inspecting' },
        { actorId: actor.id, status: 'validating' },
        { actorId: actor.id, status: 'applying' },
      ],
    });
    if (activeJobs >= 2) {
      throw new AppException(429, 'IMPORT_CONCURRENCY_LIMIT', 'Bạn đã có hai import đang xử lý.');
    }

    const format = this.inspector.inspect(file, dto.format);
    const id = randomUUID();
    const safeName = basename(file.originalname)
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .slice(-180);
    const digest = createHash('sha256').update(file.buffer).digest('hex');
    const objectKey = `quarantine/imports/${revisionId}/${id}/${digest}-${safeName}`;
    await this.storage.putBuffer(
      objectKey,
      file.buffer,
      file.mimetype || 'application/octet-stream',
    );

    const job = this.jobs.create({
      id,
      revisionId,
      actorId: actor.id,
      objectKey,
      fileName: safeName,
      sizeBytes: file.size,
      format,
      mode: dto.mode,
      status: 'uploaded',
      progress: 0,
      mapping: { clientRequestId: dto.clientRequestId, sha256: digest },
      counts: {},
      idempotencyKey,
      failureCode: null,
    });
    try {
      await this.jobs.save(job);
    } catch (error) {
      const raced = await this.jobs.findOneBy({ revisionId, idempotencyKey });
      if (raced) return this.response(raced);
      throw error;
    }
    await this.queue.add(
      IMPORT_INSPECT_JOB,
      { importId: id },
      {
        jobId: `inspect-${id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    return this.response(job);
  }

  async get(id: string, actor: NonNullable<RequestWithContext['principal']>) {
    const job = await this.jobs.findOneBy({ id });
    if (!job) throw new AppException(404, 'IMPORT_NOT_FOUND', 'Không tìm thấy import.');
    if (actor.role !== 'system_admin' && job.actorId !== actor.id) {
      throw new AppException(403, 'IMPORT_FORBIDDEN', 'Bạn không có quyền xem import này.');
    }
    return this.response(job);
  }

  private response(job: ImportJobEntity) {
    return {
      id: job.id,
      revisionId: job.revisionId,
      status: job.status,
      format: job.format,
      mode: job.mode,
      file: { name: job.fileName, sizeBytes: job.sizeBytes },
      progress: job.progress,
      counts: job.counts,
      failureCode: job.failureCode,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}
