import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { RequestWithContext } from '../common/http/request-context';
import {
  USER_IMPORT_APPLY_JOB,
  USER_IMPORT_INSPECT_JOB,
  USER_IMPORT_QUEUE,
  USER_IMPORT_VALIDATE_JOB,
} from '../jobs/jobs.constants';
import { requireIdempotencyKey } from '../layers/etag';
import { StorageService } from '../storage/storage.service';
import { USER_ROLES, type UserRole } from '../domain/enums';
import type { ApplyUserImportDto, ValidateUserImportDto } from './user-import.dto';
import { detectUserImport, UserImportParserError } from './user-import.parser';
import { userImportIssueResponse, userImportResponse } from './user-import.response';
import { UserImportIssueEntity, UserImportJobEntity } from './user-import.entity';

const EMPTY_COUNTS = { total: 0, valid: 0, invalid: 0, applied: 0, skipped: 0 };

@Injectable()
export class UserImportsService {
  constructor(
    @InjectRepository(UserImportJobEntity)
    private readonly jobs: Repository<UserImportJobEntity>,
    @InjectRepository(UserImportIssueEntity)
    private readonly issueRepository: Repository<UserImportIssueEntity>,
    @InjectQueue(USER_IMPORT_QUEUE) private readonly queue: Queue,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    file: Express.Multer.File | undefined,
    idempotencyHeader: string | undefined,
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    if (!file) throw new AppException(400, 'USER_IMPORT_FILE_REQUIRED', 'Thiếu tệp import.');
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    let format: UserImportJobEntity['format'];
    try {
      format = detectUserImport(file);
    } catch (error) {
      this.throwParserError(error);
    }
    const fileSha256 = createHash('sha256').update(file.buffer).digest('hex');
    const uploadRequestDigest = this.idempotency.digest({ fileSha256, format, size: file.size });
    const existing = await this.jobs.findOneBy({ actorId: actor.id, idempotencyKey });
    if (existing) {
      this.assertSameUpload(existing, uploadRequestDigest);
      await this.enqueueInspection(existing);
      return userImportResponse(existing);
    }
    const id = randomUUID();
    const safeName = basename(file.originalname)
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .slice(-180);
    const objectKey = `quarantine/user-imports/${actor.id}/${id}/${fileSha256}-${safeName}`;
    await this.storage.putBuffer(
      objectKey,
      file.buffer,
      file.mimetype || 'application/octet-stream',
    );
    const job = this.jobs.create({
      id,
      actorId: actor.id,
      objectKey,
      fileName: safeName || `user-import.${format}`,
      fileSha256,
      sizeBytes: file.size,
      format,
      status: 'uploaded',
      progress: 0,
      counts: { ...EMPTY_COUNTS },
      sheets: [],
      selectedSheet: null,
      validationVersion: 0,
      idempotencyKey,
      uploadRequestDigest,
      applyContext: null,
      failureCode: null,
      cleanupStatus: 'pending',
    });
    let outcome: { job: UserImportJobEntity; created: boolean };
    try {
      outcome = await this.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `user-import-upload:${actor.id}`,
        ]);
        const raced = await manager.findOneBy(UserImportJobEntity, {
          actorId: actor.id,
          idempotencyKey,
        });
        if (raced) return { job: raced, created: false };
        const active = await manager
          .createQueryBuilder(UserImportJobEntity, 'job')
          .where('job.actor_id = :actorId', { actorId: actor.id })
          .andWhere('job.status IN (:...statuses)', {
            statuses: ['uploaded', 'inspecting', 'inspected', 'validating', 'ready', 'applying'],
          })
          .getCount();
        if (active >= 2) {
          throw new AppException(
            429,
            'USER_IMPORT_CONCURRENCY_LIMIT',
            'Bạn đã có hai import tài khoản chưa kết thúc.',
          );
        }
        return { job: await manager.save(UserImportJobEntity, job), created: true };
      });
    } catch (error) {
      await this.storage.remove(objectKey).catch(() => undefined);
      throw error;
    }
    if (!outcome.created) {
      await this.storage.remove(objectKey).catch(() => undefined);
      this.assertSameUpload(outcome.job, uploadRequestDigest);
    }
    await this.enqueueInspection(outcome.job);
    return userImportResponse(outcome.job);
  }

  async get(id: string, actor: NonNullable<RequestWithContext['principal']>) {
    return userImportResponse(await this.ownedJob(id, actor.id));
  }

  async validate(
    id: string,
    dto: ValidateUserImportDto,
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    const job = await this.dataSource.transaction(async (manager) => {
      const current = await manager.findOne(UserImportJobEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      this.assertOwned(current, actor.id);
      if (!current) throw new Error('unreachable');
      if (current.status === 'validating') return current;
      if (current.status === 'failed' && current.failureCode === 'USER_IMPORT_VALIDATE_FAILED') {
        current.status = 'validating';
        current.progress = 10;
        current.failureCode = null;
        return manager.save(UserImportJobEntity, current);
      }
      if (current.status === 'ready' && (dto.sheet ?? null) === current.selectedSheet)
        return current;
      if (!['inspected', 'ready'].includes(current.status)) {
        throw new AppException(
          409,
          'USER_IMPORT_STATE_INVALID',
          'Import chưa sẵn sàng để kiểm tra.',
        );
      }
      let selectedSheet: string | null = null;
      if (current.format === 'xlsx') {
        selectedSheet = dto.sheet ?? (current.sheets.length === 1 ? current.sheets[0]! : null);
        if (!selectedSheet) {
          throw new AppException(
            422,
            'USER_IMPORT_SHEET_REQUIRED',
            'Hãy chọn worksheet cần import.',
          );
        }
        if (!current.sheets.includes(selectedSheet)) {
          throw new AppException(
            422,
            'USER_IMPORT_SHEET_NOT_FOUND',
            'Worksheet đã chọn không tồn tại.',
          );
        }
      } else if (dto.sheet) {
        throw new AppException(422, 'USER_IMPORT_SHEET_NOT_ALLOWED', 'CSV không hỗ trợ worksheet.');
      }
      current.status = 'validating';
      current.progress = 10;
      current.selectedSheet = selectedSheet;
      current.validationVersion += 1;
      current.failureCode = null;
      current.counts = { ...EMPTY_COUNTS };
      return manager.save(UserImportJobEntity, current);
    });
    await this.enqueueValidation(job);
    return userImportResponse(job);
  }

  async apply(
    id: string,
    dto: ApplyUserImportDto,
    idempotencyHeader: string | undefined,
    requestId: string,
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const requestDigest = this.idempotency.digest({
      jobId: id,
      validRowPolicy: dto.validRowPolicy,
    });
    const outcome = await this.dataSource.transaction(async (manager) => {
      const claim = await this.idempotency.claim<ReturnType<typeof userImportResponse>>(
        manager,
        actor.id,
        `user_import.apply.${id}`,
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) {
        if (!claim.response) {
          throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh import đang được xử lý.');
        }
        return { response: claim.response, shouldEnqueue: claim.response.status === 'applying' };
      }
      const current = await manager.findOne(UserImportJobEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      this.assertOwned(current, actor.id);
      if (!current) throw new Error('unreachable');
      if (current.status !== 'ready') {
        throw new AppException(
          409,
          'USER_IMPORT_STATE_INVALID',
          'Import chưa sẵn sàng để áp dụng.',
        );
      }
      if (current.counts.valid < 1) {
        throw new AppException(
          422,
          'USER_IMPORT_NO_VALID_ROWS',
          'Import không có dòng hợp lệ để áp dụng.',
        );
      }
      current.status = 'applying';
      current.progress = 10;
      current.applyContext = {
        actorRole: this.actorRole(actor.role),
        idempotencyKey,
        requestDigest,
        requestId,
      };
      const saved = await manager.save(UserImportJobEntity, current);
      const response = userImportResponse(saved);
      await this.idempotency.prepare(
        manager,
        actor.id,
        `user_import.apply.${id}`,
        idempotencyKey,
        response,
        202,
      );
      return { response, shouldEnqueue: true };
    });
    if (outcome.shouldEnqueue) await this.enqueueApply(id, idempotencyKey);
    return outcome.response;
  }

  async issues(
    id: string,
    query: { cursor?: string; limit?: string; code?: string },
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    await this.ownedJob(id, actor.id);
    const cursor = this.cursor(query.cursor);
    const limit = this.limit(query.limit);
    const code = this.issueCode(query.code);
    const rows = await this.issueRepository
      .createQueryBuilder('issue')
      .where('issue.job_id = :id', { id })
      .andWhere('issue.id > :cursor', { cursor })
      .andWhere(code ? 'issue.code = :code' : 'TRUE', { code })
      .orderBy('issue.id', 'ASC')
      .take(limit + 1)
      .getMany();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      data: page.map((issue) => userImportIssueResponse(issue)),
      meta: {
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore,
        limit,
      },
    };
  }

  async report(
    id: string,
    query: { cursor?: string; limit?: string; code?: string },
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    const job = await this.ownedJob(id, actor.id);
    const issuePage = await this.issues(id, query, actor);
    return {
      data: {
        job: userImportResponse(job),
        issues: issuePage.data,
      },
      meta: issuePage.meta,
    };
  }

  private async enqueueInspection(job: UserImportJobEntity): Promise<void> {
    const retryable =
      ['uploaded', 'inspecting'].includes(job.status) ||
      (job.status === 'failed' && job.failureCode === 'USER_IMPORT_INSPECT_FAILED');
    if (!retryable) return;
    await this.enqueue(USER_IMPORT_INSPECT_JOB, `user-import-inspect-${job.id}`, {
      importId: job.id,
    });
  }

  private async enqueueValidation(job: UserImportJobEntity): Promise<void> {
    if (job.status !== 'validating') return;
    await this.enqueue(
      USER_IMPORT_VALIDATE_JOB,
      `user-import-validate-${job.id}-${job.validationVersion}`,
      { importId: job.id, validationVersion: job.validationVersion },
    );
  }

  private async enqueueApply(id: string, idempotencyKey: string): Promise<void> {
    await this.enqueue(USER_IMPORT_APPLY_JOB, `user-import-apply-${id}-${idempotencyKey}`, {
      importId: id,
      idempotencyKey,
    });
  }

  private async enqueue(name: string, jobId: string, data: Record<string, unknown>): Promise<void> {
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') {
        await existing.retry();
        return;
      }
      if (state === 'completed') await existing.remove();
      else return;
    }
    await this.queue.add(name, data, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }

  private async ownedJob(id: string, actorId: string): Promise<UserImportJobEntity> {
    const job = await this.jobs.findOneBy({ id });
    this.assertOwned(job, actorId);
    return job!;
  }

  private assertOwned(job: UserImportJobEntity | null, actorId: string): void {
    if (!job || job.actorId !== actorId) {
      throw new AppException(404, 'USER_IMPORT_NOT_FOUND', 'Không tìm thấy import tài khoản.');
    }
  }

  private assertSameUpload(job: UserImportJobEntity, uploadRequestDigest: string): void {
    if (job.uploadRequestDigest !== uploadRequestDigest) {
      throw new AppException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key đã được dùng với upload khác.',
      );
    }
  }

  private cursor(value: string | undefined): string {
    if (value === undefined) return '0';
    if (!/^\d+$/.test(value)) {
      throw new AppException(400, 'VALIDATION_FAILED', 'Cursor không hợp lệ.');
    }
    return value;
  }

  private limit(value: string | undefined): number {
    if (value === undefined) return 100;
    if (!/^\d+$/.test(value)) {
      throw new AppException(400, 'VALIDATION_FAILED', 'Limit không hợp lệ.');
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      throw new AppException(400, 'VALIDATION_FAILED', 'Limit phải từ 1 đến 200.');
    }
    return parsed;
  }

  private issueCode(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!/^[A-Z][A-Z0-9_]{2,99}$/.test(value)) {
      throw new AppException(400, 'VALIDATION_FAILED', 'Mã lỗi không hợp lệ.');
    }
    return value;
  }

  private actorRole(value: string): UserRole {
    if (!USER_ROLES.includes(value as UserRole)) {
      throw new AppException(403, 'ROLE_FORBIDDEN', 'Vai trò không hợp lệ.');
    }
    return value as UserRole;
  }

  private throwParserError(error: unknown): never {
    if (!(error instanceof UserImportParserError)) throw error;
    const status = error.code.includes('FORMAT_UNSUPPORTED') ? 415 : 422;
    throw new AppException(status, error.code, 'Tệp import tài khoản không hợp lệ.');
  }
}
