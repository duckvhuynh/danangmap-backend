import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { UserRole } from '../domain/enums';

export const USER_IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type UserImportFormat = (typeof USER_IMPORT_FORMATS)[number];

export const USER_IMPORT_STATUSES = [
  'uploaded',
  'inspecting',
  'inspected',
  'validating',
  'ready',
  'applying',
  'completed',
  'failed',
] as const;
export type UserImportStatus = (typeof USER_IMPORT_STATUSES)[number];

export interface UserImportCounts {
  total: number;
  valid: number;
  invalid: number;
  applied: number;
  skipped: number;
}

export interface UserImportApplyContext {
  actorRole: UserRole;
  idempotencyKey: string;
  requestDigest: string;
  requestId: string;
}

@Entity({ name: 'user_import_jobs' })
@Index('uq_user_import_jobs_actor_idempotency', ['actorId', 'idempotencyKey'], { unique: true })
@Index('idx_user_import_jobs_actor_created', ['actorId', 'createdAt'])
export class UserImportJobEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'actor_id', type: 'uuid' }) actorId: string;
  @Column({ name: 'object_key', type: 'text', nullable: true }) objectKey: string | null;
  @Column({ name: 'file_name', type: 'text' }) fileName: string;
  @Column({ name: 'file_sha256', type: 'text' }) fileSha256: string;
  @Column({ name: 'size_bytes', type: 'integer' }) sizeBytes: number;
  @Column({ type: 'text' }) format: UserImportFormat;
  @Column({ type: 'text', default: 'uploaded' }) status: UserImportStatus;
  @Column({ type: 'integer', default: 0 }) progress: number;
  @Column({
    type: 'jsonb',
    default: () => '\'{"total":0,"valid":0,"invalid":0,"applied":0,"skipped":0}\'::jsonb',
  })
  counts: UserImportCounts;
  @Column({ type: 'text', array: true, default: () => "'{}'::text[]" }) sheets: string[];
  @Column({ name: 'selected_sheet', type: 'text', nullable: true }) selectedSheet: string | null;
  @Column({ name: 'validation_version', type: 'integer', default: 0 }) validationVersion: number;
  @Column({ name: 'idempotency_key', type: 'uuid' }) idempotencyKey: string;
  @Column({ name: 'upload_request_digest', type: 'text' }) uploadRequestDigest: string;
  @Column({ name: 'apply_context', type: 'jsonb', nullable: true })
  applyContext: UserImportApplyContext | null;
  @Column({ name: 'failure_code', type: 'text', nullable: true }) failureCode: string | null;
  @Column({ name: 'cleanup_status', type: 'text', default: 'pending' })
  cleanupStatus: 'pending' | 'completed';
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'user_import_rows' })
@Index('uq_user_import_rows_job_row', ['jobId', 'rowNumber'], { unique: true })
@Index('idx_user_import_rows_job_valid', ['jobId', 'valid', 'rowNumber'])
export class UserImportRowEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' }) id: string;
  @Column({ name: 'job_id', type: 'uuid' }) jobId: string;
  @Column({ name: 'row_number', type: 'integer' }) rowNumber: number;
  @Column({ type: 'text' }) email: string;
  @Column({ name: 'email_normalized', type: 'text' }) emailNormalized: string;
  @Column({ type: 'text' }) username: string;
  @Column({ name: 'username_normalized', type: 'text' }) usernameNormalized: string;
  @Column({ name: 'display_name', type: 'text' }) displayName: string;
  @Column({ type: 'text', nullable: true }) role: UserRole | null;
  @Column({ type: 'boolean' }) valid: boolean;
  @Column({ type: 'text' }) checksum: string;
}

@Entity({ name: 'user_import_issues' })
@Index('idx_user_import_issues_job_cursor', ['jobId', 'id'])
@Index('idx_user_import_issues_job_filter', ['jobId', 'severity', 'code', 'id'])
export class UserImportIssueEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' }) id: string;
  @Column({ name: 'job_id', type: 'uuid' }) jobId: string;
  @Column({ name: 'row_number', type: 'integer' }) rowNumber: number;
  @Column({ type: 'text' }) severity: 'error';
  @Column({ type: 'text' }) code: string;
  @Column({ type: 'text', nullable: true }) field: string | null;
}

@Entity({ name: 'user_import_invites' })
@Index('uq_user_import_invites_job_row', ['jobId', 'rowNumber'], { unique: true })
export class UserImportInviteEntity {
  @PrimaryColumn({ name: 'invite_id', type: 'uuid' }) inviteId: string;
  @Column({ name: 'job_id', type: 'uuid' }) jobId: string;
  @Column({ name: 'row_number', type: 'integer' }) rowNumber: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
