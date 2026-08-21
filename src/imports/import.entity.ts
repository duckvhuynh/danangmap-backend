import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ImportFormat, ImportMode } from '../domain/enums';

@Entity({ name: 'import_jobs' })
@Index('uq_import_idempotency', ['revisionId', 'idempotencyKey'], { unique: true })
export class ImportJobEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @Column({ name: 'actor_id', type: 'uuid' }) actorId: string;
  @Column({ name: 'object_key', type: 'text' }) objectKey: string;
  @Column({ name: 'file_name', type: 'text' }) fileName: string;
  @Column({ name: 'size_bytes', type: 'integer' }) sizeBytes: number;
  @Column({ type: 'text' }) format: ImportFormat;
  @Column({ type: 'text' }) mode: ImportMode;
  @Column({ type: 'text', default: 'uploaded' }) status: string;
  @Column({ type: 'integer', default: 0 }) progress: number;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) mapping: Record<string, unknown>;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) counts: Record<string, number>;
  @Column({ name: 'idempotency_key', type: 'uuid' }) idempotencyKey: string;
  @Column({ name: 'failure_code', type: 'text', nullable: true }) failureCode: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}
