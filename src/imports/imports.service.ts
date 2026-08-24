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
  IMPORT_APPLY_JOB,
  IMPORT_INSPECT_JOB,
  IMPORT_QUEUE,
  IMPORT_VALIDATE_JOB,
} from '../jobs/jobs.constants';
import { requireIdempotencyKey, requireRevisionVersion } from '../layers/etag';
import { LayerFieldEntity, LayerRevisionEntity } from '../layers/layer.entities';
import { StorageService } from '../storage/storage.service';
import type { ApplyImportDto, CreateImportDto, UpdateImportMappingDto } from './import.dto';
import { ImportFileInspector } from './import-file.inspector';
import { ImportJobEntity } from './import.entity';

@Injectable()
export class ImportsService {
  constructor(
    @InjectRepository(ImportJobEntity) private readonly jobs: Repository<ImportJobEntity>,
    @InjectRepository(LayerRevisionEntity)
    private readonly revisions: Repository<LayerRevisionEntity>,
    @InjectRepository(LayerFieldEntity) private readonly fields: Repository<LayerFieldEntity>,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly inspector: ImportFileInspector,
    private readonly idempotency: IdempotencyService,
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
    const format = this.inspector.inspect(file, dto.format);
    const digest = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.jobs.findOneBy({ revisionId, idempotencyKey });
    if (existing) {
      this.assertSameUpload(existing, actor.id, dto, format, digest);
      await this.enqueueInspection(existing);
      return this.response(existing);
    }

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

    const id = randomUUID();
    const safeName = basename(file.originalname)
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .slice(-180);
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
      await this.storage.remove(objectKey).catch(() => undefined);
      if (raced) {
        this.assertSameUpload(raced, actor.id, dto, format, digest);
        await this.enqueueInspection(raced);
        return this.response(raced);
      }
      throw error;
    }
    await this.enqueueInspection(job);
    return this.response(job);
  }

  private assertSameUpload(
    existing: ImportJobEntity,
    actorId: string,
    dto: CreateImportDto,
    format: ImportJobEntity['format'],
    digest: string,
  ): void {
    if (
      existing.actorId !== actorId ||
      existing.mode !== dto.mode ||
      existing.format !== format ||
      existing.mapping.clientRequestId !== dto.clientRequestId ||
      existing.mapping.sha256 !== digest
    ) {
      throw new AppException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key đã được dùng với upload khác.',
      );
    }
  }

  private async enqueueInspection(job: ImportJobEntity): Promise<void> {
    const retryable =
      ['uploaded', 'inspecting'].includes(job.status) ||
      (job.status === 'failed' && job.failureCode === 'IMPORT_INSPECT_FAILED');
    if (!retryable) return;
    const jobId = `inspect-${job.id}`;
    const queued = await this.queue.getJob(jobId);
    if (queued) {
      const state = await queued.getState();
      if (state === 'failed') {
        await queued.retry();
        return;
      } else if (state === 'completed') {
        await queued.remove();
      } else {
        return;
      }
    }
    await this.queue.add(
      IMPORT_INSPECT_JOB,
      { importId: job.id },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  }

  async get(id: string, actor: NonNullable<RequestWithContext['principal']>) {
    const job = await this.ownedJob(id, actor);
    return this.response(job);
  }

  async updateMapping(
    id: string,
    dto: UpdateImportMappingDto,
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    const job = await this.ownedJob(id, actor);
    if (!['mapping_required', 'ready'].includes(job.status)) {
      throw new AppException(
        409,
        'IMPORT_STATE_INVALID',
        'Import chưa sẵn sàng để cập nhật mapping.',
      );
    }
    if (dto.sourceCrs !== 'EPSG:4326') {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'Import hiện chỉ hỗ trợ hệ tọa độ EPSG:4326.',
      );
    }
    this.validateFormatMapping(job.format, dto);
    const entries = Object.entries(dto.fields);
    if (entries.length > 256) {
      throw new AppException(422, 'IMPORT_MAPPING_INVALID', 'Mapping hỗ trợ tối đa 256 cột.');
    }
    const revisionFields = await this.fields.findBy({ revisionId: job.revisionId });
    const targetKeys = new Set(revisionFields.map((field) => field.key));
    const specialTargets = new Set(['feature_id', 'external_source', 'external_id']);
    const mappedTargets = new Set<string>();
    for (const [source, target] of entries) {
      if (!this.isSourceColumn(source)) {
        throw new AppException(422, 'IMPORT_MAPPING_INVALID', 'Tên cột nguồn không hợp lệ.');
      }
      if (!targetKeys.has(target) && !specialTargets.has(target)) {
        throw new AppException(
          422,
          'IMPORT_MAPPING_INVALID',
          `Field đích không tồn tại: ${target}`,
        );
      }
      if (mappedTargets.has(target)) {
        throw new AppException(422, 'IMPORT_MAPPING_INVALID', `Field đích bị map trùng: ${target}`);
      }
      mappedTargets.add(target);
    }
    if (
      dto.upsert?.matchBy === 'external_identity' &&
      (!mappedTargets.has('external_source') || !mappedTargets.has('external_id'))
    ) {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'Upsert external identity cần map external_source và external_id.',
      );
    }
    if (dto.upsert?.matchBy === 'feature_id' && !mappedTargets.has('feature_id')) {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'Upsert feature_id cần map cột nguồn vào feature_id.',
      );
    }
    if (mappedTargets.has('feature_id') && dto.upsert?.matchBy !== 'feature_id') {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'feature_id chỉ được map khi upsert.matchBy=feature_id.',
      );
    }
    if (job.mode === 'upsert' && !dto.upsert?.matchBy) {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'Chế độ upsert cần khai báo upsert.matchBy.',
      );
    }
    if (job.mode !== 'upsert' && dto.upsert !== undefined) {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'Chỉ chế độ upsert được khai báo upsert.matchBy.',
      );
    }
    const mapping = {
      ...job.mapping,
      planVersion: Number(job.mapping.planVersion ?? 0) + 1,
      plan: dto,
      apply: undefined,
    };
    await this.dataSource.transaction(async (manager) => {
      await manager.query('DELETE FROM import_staged_features WHERE import_id=$1', [id]);
      await manager.query('DELETE FROM import_issues WHERE import_id=$1', [id]);
      await manager.update(ImportJobEntity, id, {
        mapping,
        status: 'mapping_required',
        progress: 100,
        failureCode: null,
        counts: { total: Number(job.counts.total ?? 0) },
      });
    });
    return this.response(await this.jobs.findOneByOrFail({ id }));
  }

  async validate(id: string, actor: NonNullable<RequestWithContext['principal']>) {
    await this.ownedJob(id, actor);
    const transition = await this.dataSource.transaction(async (manager) => {
      const job = await manager
        .getRepository(ImportJobEntity)
        .createQueryBuilder('job')
        .setLock('pessimistic_write')
        .where('job.id=:id', { id })
        .getOneOrFail();
      if (job.status === 'validating' || job.status === 'ready') {
        return { job, shouldEnqueue: false, planVersion: Number(job.mapping.planVersion ?? 0) };
      }
      if (job.status !== 'mapping_required' || !job.mapping.plan) {
        throw new AppException(
          409,
          'IMPORT_MAPPING_REQUIRED',
          'Import cần mapping trước khi validate.',
        );
      }
      job.status = 'validating';
      job.progress = 0;
      job.failureCode = null;
      return {
        job: await manager.save(ImportJobEntity, job),
        shouldEnqueue: true,
        planVersion: Number(job.mapping.planVersion ?? 0),
      };
    });
    if (transition.shouldEnqueue) {
      try {
        await this.queue.add(
          IMPORT_VALIDATE_JOB,
          { importId: id },
          {
            jobId: `validate-${id}-${transition.planVersion}`,
            attempts: 1,
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        );
      } catch (error) {
        await this.jobs.update(
          { id, status: 'validating' },
          { status: 'mapping_required', progress: 100 },
        );
        throw error;
      }
    }
    return this.response(transition.job);
  }

  async issues(
    id: string,
    cursorValue: string | undefined,
    limitValue: string | undefined,
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    await this.ownedJob(id, actor);
    const cursor = cursorValue === undefined ? 0 : Number(cursorValue);
    const limit = limitValue === undefined ? 100 : Number(limitValue);
    if (
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new AppException(400, 'INVALID_PAGINATION', 'Cursor hoặc limit không hợp lệ.');
    }
    const rows = (await this.dataSource.query(
      `SELECT id::text,row_number AS "rowNumber",severity,code,field
       FROM import_issues WHERE import_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
      [id, cursor, limit + 1],
    )) as Array<{
      id: string;
      rowNumber: number;
      severity: string;
      code: string;
      field: string | null;
    }>;
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    return {
      data,
      meta: { nextCursor: hasMore ? data.at(-1)?.id : null, hasMore, limit },
    };
  }

  async apply(
    id: string,
    dto: ApplyImportDto,
    ifMatch: string | undefined,
    idempotencyHeader: string | undefined,
    requestId: string,
    actor: NonNullable<RequestWithContext['principal']>,
  ) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const expectedVersion = requireRevisionVersion(
      ifMatch,
      (await this.ownedJob(id, actor)).revisionId,
    );
    const requestDigest = this.idempotency.digest({
      id,
      expectedVersion,
      dto: {
        ...dto,
        acknowledgedWarningCodes: [...dto.acknowledgedWarningCodes].sort(),
      },
    });
    const transition = await this.dataSource.transaction(async (manager) => {
      const receipt = await this.idempotency.claim<ReturnType<ImportsService['response']>>(
        manager,
        actor.id,
        'import.apply',
        idempotencyKey,
        requestDigest,
      );
      if (!receipt.owner && !receipt.pending) {
        if (!receipt.response) {
          throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
        }
        return {
          response: receipt.response,
          shouldEnqueue: false,
          shouldComplete: false,
        };
      }
      const job = await manager
        .getRepository(ImportJobEntity)
        .createQueryBuilder('job')
        .setLock('pessimistic_write')
        .where('job.id=:id', { id })
        .getOne();
      if (!job) throw new AppException(404, 'IMPORT_NOT_FOUND', 'Không tìm thấy import.');
      if (
        !['editor', 'system_admin'].includes(actor.role) ||
        (actor.role !== 'system_admin' && job.actorId !== actor.id)
      ) {
        throw new AppException(403, 'IMPORT_FORBIDDEN', 'Bạn không có quyền xem import này.');
      }
      const priorApply = job.mapping.apply as
        { idempotencyKey?: string; requestDigest?: string } | undefined;
      if (['applying', 'completed'].includes(job.status)) {
        if (
          priorApply?.idempotencyKey === idempotencyKey &&
          priorApply.requestDigest === requestDigest
        ) {
          const response = receipt.response ?? this.response(job);
          if (receipt.owner) {
            await this.idempotency.prepare(
              manager,
              actor.id,
              'import.apply',
              idempotencyKey,
              response,
              202,
            );
          }
          return { response, shouldEnqueue: true, shouldComplete: true };
        }
        throw new AppException(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Import đã dùng idempotency key khác.',
        );
      }
      if (job.status !== 'ready') {
        throw new AppException(409, 'IMPORT_STATE_INVALID', 'Import chưa sẵn sàng để apply.');
      }
      if (Number(job.counts.invalid ?? 0) > 0 && !dto.skipInvalid) {
        throw new AppException(
          422,
          'IMPORT_HAS_ERRORS',
          'Import còn dòng lỗi; draft chưa thay đổi.',
        );
      }
      if (Number(job.counts.valid ?? 0) < 1) {
        throw new AppException(
          422,
          'IMPORT_NO_VALID_ROWS',
          'Import không có dòng hợp lệ; draft chưa thay đổi.',
        );
      }
      const revision = await manager.findOneBy(LayerRevisionEntity, { id: job.revisionId });
      if (!revision || revision.status !== 'draft') {
        throw new AppException(
          409,
          'REVISION_NOT_EDITABLE',
          'Revision không còn ở trạng thái draft.',
        );
      }
      if (revision.lockVersion !== expectedVersion) {
        throw new AppException(412, 'ETAG_MISMATCH', 'Revision đã thay đổi.', {
          currentEtag: `"rev-${revision.id}-v${revision.lockVersion}"`,
        });
      }
      job.mapping = {
        ...job.mapping,
        apply: {
          idempotencyKey,
          requestDigest,
          expectedVersion,
          skipInvalid: dto.skipInvalid,
          acknowledgedWarningCodes: dto.acknowledgedWarningCodes,
          requestId,
          actorRole: actor.role,
        },
      };
      job.status = 'applying';
      job.progress = 0;
      job.failureCode = null;
      const saved = await manager.save(ImportJobEntity, job);
      const response = this.response(saved);
      await this.idempotency.prepare(
        manager,
        actor.id,
        'import.apply',
        idempotencyKey,
        response,
        202,
      );
      return { response, shouldEnqueue: true, shouldComplete: true };
    });
    if (transition.shouldEnqueue) {
      await this.queue.add(
        IMPORT_APPLY_JOB,
        { importId: id },
        {
          jobId: `apply-${id}-${idempotencyKey}`,
          attempts: 1,
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    }
    if (transition.shouldComplete) {
      await this.dataSource.transaction((manager) =>
        this.idempotency.complete(
          manager,
          actor.id,
          'import.apply',
          idempotencyKey,
          transition.response,
          202,
        ),
      );
    }
    return transition.response;
  }

  private response(job: ImportJobEntity) {
    const rawInspection = job.mapping.inspection as
      | {
          parserStatus?: unknown;
          sheets?: unknown;
          maxRecords?: unknown;
          maxVerticesPerFeature?: unknown;
          maxVerticesPerJob?: unknown;
          maxExpandedBytes?: unknown;
          maxIssues?: unknown;
        }
      | undefined;
    return {
      id: job.id,
      revisionId: job.revisionId,
      status: job.status,
      format: job.format,
      mode: job.mode,
      file: { name: job.fileName, sizeBytes: job.sizeBytes },
      progress: job.progress,
      counts: job.counts,
      inspection: {
        parserStatus:
          typeof rawInspection?.parserStatus === 'string' ? rawInspection.parserStatus : 'pending',
        sheets: Array.isArray(rawInspection?.sheets)
          ? rawInspection.sheets.filter((sheet): sheet is string => typeof sheet === 'string')
          : [],
        limits: {
          maxRecords: this.inspectionLimit(rawInspection?.maxRecords),
          maxVerticesPerFeature: this.inspectionLimit(rawInspection?.maxVerticesPerFeature),
          maxVerticesPerJob: this.inspectionLimit(rawInspection?.maxVerticesPerJob),
          maxExpandedBytes: this.inspectionLimit(rawInspection?.maxExpandedBytes),
          maxIssues: this.inspectionLimit(rawInspection?.maxIssues),
        },
      },
      canApplyWithSkipInvalid: job.status === 'ready' && Number(job.counts.valid ?? 0) > 0,
      failureCode: job.failureCode,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private inspectionLimit(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private async ownedJob(id: string, actor: NonNullable<RequestWithContext['principal']>) {
    const job = await this.jobs.findOneBy({ id });
    if (!job) throw new AppException(404, 'IMPORT_NOT_FOUND', 'Không tìm thấy import.');
    if (
      !['editor', 'system_admin'].includes(actor.role) ||
      (actor.role !== 'system_admin' && job.actorId !== actor.id)
    ) {
      throw new AppException(403, 'IMPORT_FORBIDDEN', 'Bạn không có quyền xem import này.');
    }
    return job;
  }

  private validateFormatMapping(format: ImportJobEntity['format'], dto: UpdateImportMappingDto) {
    const geometryKind = dto.geometry.kind;
    const geometryColumns = [
      dto.geometry.longitudeColumn,
      dto.geometry.latitudeColumn,
      dto.geometry.geometryColumn,
    ].filter((column): column is string => column !== undefined);
    if (geometryColumns.some((column) => !this.isSourceColumn(column))) {
      throw new AppException(422, 'IMPORT_MAPPING_INVALID', 'Tên cột geometry không hợp lệ.');
    }
    if (format === 'geojson' && geometryKind !== 'geojson') {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'GeoJSON yêu cầu geometry.kind=geojson.',
      );
    }
    if (format === 'kml' && geometryKind !== 'kml_geometry') {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'KML yêu cầu geometry.kind=kml_geometry.',
      );
    }
    if (['csv', 'xlsx'].includes(format) && !['coordinates', 'wkt'].includes(geometryKind)) {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'CSV/XLSX yêu cầu geometry.kind=coordinates hoặc wkt.',
      );
    }
    if (
      geometryKind === 'coordinates' &&
      (!dto.geometry.longitudeColumn?.trim() || !dto.geometry.latitudeColumn?.trim())
    ) {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'Coordinates mapping cần longitudeColumn và latitudeColumn.',
      );
    }
    if (geometryKind === 'wkt' && !dto.geometry.geometryColumn?.trim()) {
      throw new AppException(422, 'IMPORT_MAPPING_INVALID', 'WKT mapping cần geometryColumn.');
    }
    if (
      format === 'xlsx' &&
      (!dto.sheet?.trim() ||
        dto.sheet.length > 100 ||
        [...dto.sheet].some((character) => character.charCodeAt(0) < 32))
    ) {
      throw new AppException(422, 'IMPORT_MAPPING_INVALID', 'XLSX cần chọn một sheet.');
    }
    if (format !== 'xlsx' && dto.sheet !== undefined) {
      throw new AppException(422, 'IMPORT_MAPPING_INVALID', 'Chỉ XLSX được khai báo sheet.');
    }
    if (format !== 'csv' && (dto.encoding !== undefined || dto.delimiter !== undefined)) {
      throw new AppException(
        422,
        'IMPORT_MAPPING_INVALID',
        'Encoding và delimiter chỉ áp dụng cho CSV.',
      );
    }
  }

  private isSourceColumn(value: string): boolean {
    return (
      /^[\p{L}\p{N}_. -]{1,200}$/u.test(value) &&
      !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase())
    );
  }
}
