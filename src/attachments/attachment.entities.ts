import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const ATTACHMENT_STATUSES = [
  'uploading',
  'pending',
  'clean',
  'infected',
  'rejected',
  'deleted',
] as const;

export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

@Entity({ name: 'attachments' })
@Index('idx_attachments_owner_status_created', ['ownerId', 'status', 'createdAt'])
export class AttachmentEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text', default: 'feature_attachment' }) purpose: 'feature_attachment';
  @Column({ name: 'quarantine_key', type: 'text', unique: true }) quarantineKey: string;
  @Column({ name: 'object_key', type: 'text', unique: true, nullable: true }) objectKey:
    string | null;
  @Column({ name: 'file_name', type: 'text' }) fileName: string;
  @Column({ name: 'declared_content_type', type: 'text' }) declaredContentType: string;
  @Column({ name: 'content_type', type: 'text', nullable: true }) contentType: string | null;
  @Column({ name: 'declared_size_bytes', type: 'integer' }) declaredSizeBytes: number;
  @Column({ name: 'size_bytes', type: 'integer', nullable: true }) sizeBytes: number | null;
  @Column({ name: 'declared_sha256', type: 'text' }) declaredSha256: string;
  @Column({ type: 'text', nullable: true }) sha256: string | null;
  @Column({ type: 'text', default: 'uploading' }) status: AttachmentStatus;
  @Column({ name: 'rejection_code', type: 'text', nullable: true }) rejectionCode: string | null;
  @Column({ name: 'owner_id', type: 'uuid' }) ownerId: string;
  @Column({ name: 'upload_expires_at', type: 'timestamptz' }) uploadExpiresAt: Date;
  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true }) finalizedAt: Date | null;
  @Column({ name: 'scanned_at', type: 'timestamptz', nullable: true }) scannedAt: Date | null;
  @Column({ name: 'quarantine_removed_at', type: 'timestamptz', nullable: true })
  quarantineRemovedAt: Date | null;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'feature_version_attachments' })
export class FeatureVersionAttachmentEntity {
  @PrimaryColumn({ name: 'feature_version_id', type: 'uuid' }) featureVersionId: string;
  @PrimaryColumn({ name: 'attachment_id', type: 'uuid' }) attachmentId: string;
  @Column({ name: 'field_key', type: 'text' }) fieldKey: string;
  @Column({ name: 'display_order', type: 'integer', default: 0 }) displayOrder: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
