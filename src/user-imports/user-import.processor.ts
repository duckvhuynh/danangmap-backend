import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { UserRole } from '../domain/enums';
import {
  USER_IMPORT_APPLY_JOB,
  USER_IMPORT_INSPECT_JOB,
  USER_IMPORT_QUEUE,
  USER_IMPORT_VALIDATE_JOB,
} from '../jobs/jobs.constants';
import { InviteEntity, MailOutboxEntity } from '../identity/identity.entities';
import { StorageService } from '../storage/storage.service';
import {
  inspectUserImport,
  normalizeUserImportRow,
  parseUserImport,
  type NormalizedUserImportRow,
  type UserImportRowIssue,
  UserImportParserError,
} from './user-import.parser';
import { userImportResponse } from './user-import.response';
import {
  UserImportInviteEntity,
  UserImportIssueEntity,
  UserImportJobEntity,
  UserImportRowEntity,
} from './user-import.entity';
import { MAX_USER_IMPORT_BYTES } from './user-import-upload.guard';

interface WorkerData {
  importId: string;
  validationVersion?: number;
  idempotencyKey?: string;
}

interface StagedCandidate {
  row: NormalizedUserImportRow;
  issues: UserImportRowIssue[];
}

@Processor(USER_IMPORT_QUEUE, { concurrency: 2 })
export class UserImportProcessor extends WorkerHost {
  constructor(
    @InjectRepository(UserImportJobEntity)
    private readonly jobs: Repository<UserImportJobEntity>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
  ) {
    super();
  }

  async process(job: Job<WorkerData>): Promise<void> {
    if (job.name === USER_IMPORT_INSPECT_JOB) return this.inspect(job.data.importId);
    if (job.name === USER_IMPORT_VALIDATE_JOB) {
      return this.validate(job.data.importId, job.data.validationVersion);
    }
    if (job.name === USER_IMPORT_APPLY_JOB) {
      return this.apply(job.data.importId, job.data.idempotencyKey);
    }
  }

  private async inspect(id: string): Promise<void> {
    const job = await this.jobs.findOneBy({ id });
    const retryable =
      job?.status === 'uploaded' ||
      job?.status === 'inspecting' ||
      (job?.status === 'failed' && job.failureCode === 'USER_IMPORT_INSPECT_FAILED');
    if (!job || !retryable) return;
    await this.jobs.update(id, { status: 'inspecting', progress: 10, failureCode: null });
    try {
      const content = await this.readObject(job);
      const inspection = await inspectUserImport(content, job.format);
      await this.jobs.update(id, {
        status: 'inspected',
        progress: 100,
        sheets: inspection.sheets,
        failureCode: null,
      });
    } catch (error) {
      if (error instanceof UserImportParserError) {
        await this.terminalFailure(job, error.code);
        throw new UnrecoverableError(error.code);
      }
      await this.jobs.update(id, { status: 'failed', failureCode: 'USER_IMPORT_INSPECT_FAILED' });
      throw error;
    }
  }

  private async validate(id: string, expectedVersion: number | undefined): Promise<void> {
    const job = await this.jobs.findOneBy({ id });
    const retryable =
      job?.status === 'validating' ||
      (job?.status === 'failed' && job.failureCode === 'USER_IMPORT_VALIDATE_FAILED');
    if (!job || !retryable || expectedVersion !== job.validationVersion) return;
    await this.jobs.update(id, { status: 'validating', progress: 20, failureCode: null });
    try {
      const content = await this.readObject(job);
      const sources = await parseUserImport(content, job.format, job.selectedSheet);
      const staged = sources.map((source) => normalizeUserImportRow(source));
      this.flagFileDuplicates(staged);
      await this.dataSource.transaction(async (manager) => {
        const locked = await manager.findOne(UserImportJobEntity, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !locked ||
          locked.status !== 'validating' ||
          locked.validationVersion !== expectedVersion
        ) {
          return;
        }
        await this.flagExistingIdentities(manager, staged);
        await manager.delete(UserImportIssueEntity, { jobId: id });
        await manager.delete(UserImportRowEntity, { jobId: id });
        const rows = staged.map(({ row, issues }) =>
          manager.create(UserImportRowEntity, {
            jobId: id,
            rowNumber: row.rowNumber,
            email: row.email,
            emailNormalized: row.emailNormalized,
            username: row.username,
            usernameNormalized: row.usernameNormalized,
            displayName: row.displayName,
            role: row.role || null,
            valid: issues.length === 0,
            checksum: this.rowChecksum(row),
          }),
        );
        const issues = staged.flatMap(({ issues }) =>
          issues.map((issue) => manager.create(UserImportIssueEntity, { jobId: id, ...issue })),
        );
        for (let offset = 0; offset < rows.length; offset += 500) {
          await manager.insert(UserImportRowEntity, rows.slice(offset, offset + 500));
        }
        for (let offset = 0; offset < issues.length; offset += 500) {
          await manager.insert(UserImportIssueEntity, issues.slice(offset, offset + 500));
        }
        const valid = staged.filter((candidate) => candidate.issues.length === 0).length;
        locked.status = 'ready';
        locked.progress = 100;
        locked.failureCode = null;
        locked.counts = {
          total: staged.length,
          valid,
          invalid: staged.length - valid,
          applied: 0,
          skipped: 0,
        };
        await manager.save(UserImportJobEntity, locked);
      });
    } catch (error) {
      if (error instanceof UserImportParserError) {
        await this.terminalFailure(job, error.code);
        throw new UnrecoverableError(error.code);
      }
      await this.jobs.update(id, { status: 'failed', failureCode: 'USER_IMPORT_VALIDATE_FAILED' });
      throw error;
    }
  }

  private async apply(id: string, idempotencyKey: string | undefined): Promise<void> {
    const current = await this.jobs.findOneBy({ id });
    if (!current) return;
    if (current.status === 'completed') return this.cleanup(current);
    const retryable =
      current.status === 'applying' ||
      (current.status === 'failed' && current.failureCode === 'USER_IMPORT_APPLY_FAILED');
    if (!retryable || !idempotencyKey || current.applyContext?.idempotencyKey !== idempotencyKey) {
      return;
    }
    await this.jobs.update(id, { status: 'applying', progress: 20, failureCode: null });
    try {
      await this.dataSource.transaction(async (manager) => {
        const job = await manager.findOne(UserImportJobEntity, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!job || job.status === 'completed') return job;
        if (job.status !== 'applying' || !job.applyContext) return null;
        const rows = await manager.find(UserImportRowEntity, {
          where: { jobId: id, valid: true },
          order: { rowNumber: 'ASC' },
        });
        await this.lockIdentityRows(manager, rows);
        const lateIssues = await this.filterLateConflicts(manager, rows);
        const conflictingRows = new Set(lateIssues.map((issue) => issue.rowNumber));
        if (lateIssues.length) {
          await manager.insert(
            UserImportIssueEntity,
            lateIssues.map((issue) =>
              manager.create(UserImportIssueEntity, { jobId: id, ...issue }),
            ),
          );
          await manager
            .createQueryBuilder()
            .update(UserImportRowEntity)
            .set({ valid: false })
            .where('job_id = :id AND row_number IN (:...rows)', {
              id,
              rows: [...conflictingRows],
            })
            .execute();
        }
        const applicable = rows.filter((row) => !conflictingRows.has(row.rowNumber));
        if (applicable.length === 0) {
          job.status = 'failed';
          job.progress = 100;
          job.failureCode = 'USER_IMPORT_NO_VALID_ROWS_AT_APPLY';
          job.counts = {
            total: job.counts.total,
            valid: 0,
            invalid: job.counts.total,
            applied: 0,
            skipped: job.counts.total,
          };
          const rejected = await manager.save(UserImportJobEntity, job);
          await this.insertAudit(
            manager,
            job.actorId,
            job.applyContext.actorRole,
            job.applyContext.requestId,
            'user_import.apply_rejected',
            'user_import',
            job.id,
            { failureCode: job.failureCode, skipped: job.counts.skipped },
          );
          await this.idempotency.complete(
            manager,
            job.actorId,
            `user_import.apply.${job.id}`,
            job.applyContext.idempotencyKey,
            userImportResponse(rejected),
            202,
          );
          return rejected;
        }
        for (const row of applicable) {
          await this.createImportedInvite(manager, job, row);
        }
        job.status = 'completed';
        job.progress = 100;
        job.failureCode = null;
        job.counts = {
          total: job.counts.total,
          valid: applicable.length,
          invalid: job.counts.invalid + conflictingRows.size,
          applied: applicable.length,
          skipped: job.counts.invalid + conflictingRows.size,
        };
        const saved = await manager.save(UserImportJobEntity, job);
        await this.insertAudit(
          manager,
          job.actorId,
          job.applyContext.actorRole,
          job.applyContext.requestId,
          'user_import.applied',
          'user_import',
          job.id,
          { applied: applicable.length, skipped: saved.counts.skipped },
        );
        await this.idempotency.complete(
          manager,
          job.actorId,
          `user_import.apply.${job.id}`,
          job.applyContext.idempotencyKey,
          userImportResponse(saved),
          202,
        );
        return saved;
      });
    } catch (error) {
      await this.jobs.update(id, { status: 'failed', failureCode: 'USER_IMPORT_APPLY_FAILED' });
      throw error;
    }
    const completed = await this.jobs.findOneBy({ id });
    if (
      completed?.status === 'completed' ||
      completed?.failureCode === 'USER_IMPORT_NO_VALID_ROWS_AT_APPLY'
    ) {
      await this.cleanup(completed);
    }
  }

  private async createImportedInvite(
    manager: EntityManager,
    job: UserImportJobEntity,
    row: UserImportRowEntity,
  ): Promise<void> {
    if (!row.role || !job.applyContext) throw new Error('Validated import row is incomplete');
    const token = this.crypto.randomToken();
    const invite = await manager.save(InviteEntity, {
      email: row.emailNormalized,
      username: row.usernameNormalized,
      displayName: row.displayName,
      role: row.role,
      tokenHash: this.crypto.digest(token),
      createdBy: job.actorId,
      expiresAt: new Date(Date.now() + 72 * 60 * 60_000),
      usedAt: null,
      revokedAt: null,
      acceptedUserId: null,
    });
    await manager.insert(MailOutboxEntity, {
      templateKey: 'identity.invite',
      recipientEmail: invite.email,
      inviteId: invite.id,
      passwordResetTokenId: null,
      payloadEncrypted: this.crypto.encrypt(JSON.stringify({ inviteId: invite.id, token })),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      correlationId: job.applyContext.requestId,
    });
    await manager.insert(UserImportInviteEntity, {
      inviteId: invite.id,
      jobId: job.id,
      rowNumber: row.rowNumber,
    });
    await this.insertAudit(
      manager,
      job.actorId,
      job.applyContext.actorRole,
      job.applyContext.requestId,
      'user_import.invite_created',
      'invite',
      invite.id,
      { jobId: job.id, rowNumber: row.rowNumber, assignedRole: row.role },
    );
  }

  private async filterLateConflicts(
    manager: EntityManager,
    rows: UserImportRowEntity[],
  ): Promise<UserImportRowIssue[]> {
    if (!rows.length) return [];
    const emails = rows.map((row) => row.emailNormalized);
    const usernames = rows.map((row) => row.usernameNormalized);
    const users = (await manager.query(
      `SELECT email_normalized AS email,username_normalized AS username
       FROM users WHERE email_normalized=ANY($1::text[]) OR username_normalized=ANY($2::text[])`,
      [emails, usernames],
    )) as Array<{ email: string; username: string }>;
    const invites = (await manager.query(
      `SELECT email,username FROM invites
       WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         AND (email=ANY($1::text[]) OR username=ANY($2::text[]))`,
      [emails, usernames],
    )) as Array<{ email: string; username: string }>;
    await this.revokeExpiredInvites(manager, emails, usernames);
    const usedEmails = new Set([
      ...users.map((user) => user.email),
      ...invites.map((i) => i.email),
    ]);
    const usedUsernames = new Set([
      ...users.map((user) => user.username),
      ...invites.map((i) => i.username),
    ]);
    const issues: UserImportRowIssue[] = [];
    for (const row of rows) {
      if (usedEmails.has(row.emailNormalized)) {
        issues.push({
          rowNumber: row.rowNumber,
          severity: 'error',
          code: 'USER_IMPORT_EMAIL_CONFLICT',
          field: 'email',
        });
      }
      if (usedUsernames.has(row.usernameNormalized)) {
        issues.push({
          rowNumber: row.rowNumber,
          severity: 'error',
          code: 'USER_IMPORT_USERNAME_CONFLICT',
          field: 'username',
        });
      }
    }
    return this.uniqueIssues(issues);
  }

  private async revokeExpiredInvites(
    manager: EntityManager,
    emails: string[],
    usernames: string[],
  ): Promise<void> {
    const rows = (await manager.query(
      `UPDATE invites SET revoked_at=now()
       WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at <= now()
         AND (email=ANY($1::text[]) OR username=ANY($2::text[]))
       RETURNING id`,
      [emails, usernames],
    )) as Array<{ id: string }>;
    for (const invite of rows) {
      await manager.query(
        `UPDATE mail_outbox SET payload_encrypted=NULL,
           payload_scrubbed_at=COALESCE(payload_scrubbed_at,now()),
           status=CASE WHEN status IN ('pending','claimed','sending','failed')
             THEN 'cancelled' ELSE status END,
           claim_token=NULL,claimed_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
           last_error_code=CASE WHEN status IN ('pending','claimed','sending','failed')
             THEN 'MAIL_CREDENTIAL_INVALID' ELSE last_error_code END,
           updated_at=now() WHERE invite_id=$1`,
        [invite.id],
      );
    }
  }

  private async lockIdentityRows(
    manager: EntityManager,
    rows: UserImportRowEntity[],
  ): Promise<void> {
    const keys = [
      ...rows.map((row) => `identity:email:${row.emailNormalized}`),
      ...rows.map((row) => `identity:username:${row.usernameNormalized}`),
    ].sort();
    for (const key of new Set(keys)) {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    }
  }

  private flagFileDuplicates(staged: StagedCandidate[]): void {
    const emailCounts = this.count(staged.map(({ row }) => row.emailNormalized).filter(Boolean));
    const usernameCounts = this.count(
      staged.map(({ row }) => row.usernameNormalized).filter(Boolean),
    );
    for (const candidate of staged) {
      if ((emailCounts.get(candidate.row.emailNormalized) ?? 0) > 1) {
        candidate.issues.push({
          rowNumber: candidate.row.rowNumber,
          severity: 'error',
          code: 'USER_IMPORT_DUPLICATE_EMAIL',
          field: 'email',
        });
      }
      if ((usernameCounts.get(candidate.row.usernameNormalized) ?? 0) > 1) {
        candidate.issues.push({
          rowNumber: candidate.row.rowNumber,
          severity: 'error',
          code: 'USER_IMPORT_DUPLICATE_USERNAME',
          field: 'username',
        });
      }
      candidate.issues = this.uniqueIssues(candidate.issues);
    }
  }

  private async flagExistingIdentities(
    manager: EntityManager,
    staged: StagedCandidate[],
  ): Promise<void> {
    const emails = staged.map(({ row }) => row.emailNormalized).filter(Boolean);
    const usernames = staged.map(({ row }) => row.usernameNormalized).filter(Boolean);
    if (!emails.length && !usernames.length) return;
    const users = (await manager.query(
      `SELECT email_normalized AS email,username_normalized AS username
       FROM users WHERE email_normalized=ANY($1::text[]) OR username_normalized=ANY($2::text[])`,
      [emails, usernames],
    )) as Array<{ email: string; username: string }>;
    const invites = (await manager.query(
      `SELECT email,username FROM invites
       WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         AND (email=ANY($1::text[]) OR username=ANY($2::text[]))`,
      [emails, usernames],
    )) as Array<{ email: string; username: string }>;
    const emailConflicts = new Set([
      ...users.map((row) => row.email),
      ...invites.map((i) => i.email),
    ]);
    const usernameConflicts = new Set([
      ...users.map((row) => row.username),
      ...invites.map((i) => i.username),
    ]);
    for (const candidate of staged) {
      if (emailConflicts.has(candidate.row.emailNormalized)) {
        candidate.issues.push({
          rowNumber: candidate.row.rowNumber,
          severity: 'error',
          code: 'USER_IMPORT_EMAIL_CONFLICT',
          field: 'email',
        });
      }
      if (usernameConflicts.has(candidate.row.usernameNormalized)) {
        candidate.issues.push({
          rowNumber: candidate.row.rowNumber,
          severity: 'error',
          code: 'USER_IMPORT_USERNAME_CONFLICT',
          field: 'username',
        });
      }
      candidate.issues = this.uniqueIssues(candidate.issues);
    }
  }

  private async readObject(job: UserImportJobEntity): Promise<Buffer> {
    if (!job.objectKey) throw new UserImportParserError('USER_IMPORT_FILE_INVALID');
    const stat = await this.storage.stat(job.objectKey);
    if (stat.size !== job.sizeBytes || stat.size < 1 || stat.size > MAX_USER_IMPORT_BYTES) {
      throw new UserImportParserError('USER_IMPORT_FILE_INVALID');
    }
    const stream = await this.storage.getObject(job.objectKey);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_USER_IMPORT_BYTES) {
        stream.destroy();
        throw new UserImportParserError('USER_IMPORT_FILE_INVALID');
      }
      chunks.push(buffer);
    }
    const content = Buffer.concat(chunks, size);
    if (createHash('sha256').update(content).digest('hex') !== job.fileSha256) {
      throw new UserImportParserError('USER_IMPORT_FILE_INVALID');
    }
    return content;
  }

  private async terminalFailure(job: UserImportJobEntity, code: string): Promise<void> {
    await this.jobs.update(job.id, { status: 'failed', failureCode: code });
    await this.cleanup(job);
  }

  private async cleanup(job: UserImportJobEntity): Promise<void> {
    if (!job.objectKey || job.cleanupStatus === 'completed') return;
    await this.storage.remove(job.objectKey);
    await this.jobs.update(job.id, {
      objectKey: null,
      cleanupStatus: 'completed',
    });
  }

  private rowChecksum(row: NormalizedUserImportRow): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          displayName: row.displayName,
          email: row.emailNormalized,
          role: row.role,
          username: row.usernameNormalized,
        }),
      )
      .digest('hex');
  }

  private count(values: string[]): Map<string, number> {
    const result = new Map<string, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  }

  private uniqueIssues(issues: UserImportRowIssue[]): UserImportRowIssue[] {
    return [
      ...new Map(
        issues.map((issue) => [`${issue.rowNumber}:${issue.code}:${issue.field ?? ''}`, issue]),
      ).values(),
    ];
  }

  private async insertAudit(
    manager: EntityManager,
    actorId: string,
    actorRole: UserRole,
    requestId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [actorId, actorRole, action, resourceType, resourceId, requestId, JSON.stringify(metadata)],
    );
  }
}
