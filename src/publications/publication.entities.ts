import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type PublicationJobStatus = 'queued' | 'building' | 'succeeded' | 'failed';
export type PublicationJobPhase =
  'queued' | 'preparing' | 'scanning_features' | 'switching' | 'completed' | 'failed';

@Entity({ name: 'publication_jobs' })
@Index('idx_publication_job_layer_cursor', ['layerId', 'createdAt', 'id'])
@Index('idx_publication_job_revision_cursor', ['revisionId', 'createdAt', 'id'])
export class PublicationJobEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'layer_id', type: 'uuid' }) layerId: string;
  @Column({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @Column({ name: 'requested_by', type: 'uuid' }) requestedBy: string;
  @Column({ name: 'request_id', type: 'uuid' }) requestId: string;
  @Column({ name: 'client_intent', type: 'text' }) clientIntent: 'desktop';
  @Column({ name: 'release_note', type: 'text' }) releaseNote: string;
  @Column({ name: 'expected_active_snapshot_id', type: 'uuid', nullable: true })
  expectedActiveSnapshotId: string | null;
  @Column({ name: 'expected_active_generation', type: 'bigint', nullable: true })
  expectedActiveGeneration: string | null;
  @Column({ name: 'revision_lock_version', type: 'integer' }) revisionLockVersion: number;
  @Column({ name: 'revision_schema_version', type: 'integer' }) revisionSchemaVersion: number;
  @Column({ name: 'revision_fingerprint', type: 'text' }) revisionFingerprint: string;
  @Column({ type: 'text' }) status: PublicationJobStatus;
  @Column({ type: 'text' }) phase: PublicationJobPhase;
  @Column({ name: 'lock_version', type: 'integer', default: 1 }) lockVersion: number;
  @Column({ name: 'feature_total', type: 'integer', nullable: true }) featureTotal: number | null;
  @Column({ name: 'feature_processed', type: 'integer', default: 0 }) featureProcessed: number;
  @Column({ name: 'vertex_processed', type: 'bigint', default: 0 }) vertexProcessed: string;
  @Column({ name: 'build_feature_count', type: 'integer', nullable: true })
  buildFeatureCount: number | null;
  @Column({ name: 'build_bounds', type: 'double precision', array: true, nullable: true })
  buildBounds: number[] | null;
  @Column({ name: 'build_checksum', type: 'text', nullable: true }) buildChecksum: string | null;
  @Column({ name: 'build_manifest', type: 'jsonb', nullable: true })
  buildManifest: Record<string, unknown> | null;
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ name: 'max_attempts', type: 'integer', default: 5 }) maxAttempts: number;
  @Column({ name: 'available_at', type: 'timestamptz' }) availableAt: Date;
  @Column({ name: 'lease_token', type: 'uuid', nullable: true }) leaseToken: string | null;
  @Column({ name: 'lease_owner', type: 'text', nullable: true }) leaseOwner: string | null;
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;
  @Column({ name: 'heartbeat_at', type: 'timestamptz', nullable: true }) heartbeatAt: Date | null;
  @Column({ name: 'result_snapshot_id', type: 'uuid', nullable: true, unique: true })
  resultSnapshotId: string | null;
  @Column({ name: 'failure_code', type: 'text', nullable: true }) failureCode: string | null;
  @Column({ name: 'failure_correlation_id', type: 'uuid', nullable: true })
  failureCorrelationId: string | null;
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true }) finishedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'publication_job_batches' })
export class PublicationJobBatchEntity {
  @PrimaryColumn({ name: 'job_id', type: 'uuid' }) jobId: string;
  @PrimaryColumn({ name: 'batch_no', type: 'integer' }) batchNo: number;
  @Column({ name: 'first_feature_id', type: 'uuid' }) firstFeatureId: string;
  @Column({ name: 'last_feature_id', type: 'uuid' }) lastFeatureId: string;
  @Column({ name: 'feature_count', type: 'integer' }) featureCount: number;
  @Column({ name: 'vertex_count', type: 'bigint' }) vertexCount: string;
  @Column({ type: 'double precision', array: true, nullable: true }) bounds: number[] | null;
  @Column({ name: 'public_checksum', type: 'text' }) publicChecksum: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

export type PublicationOutboxStatus = 'pending' | 'dispatching' | 'dispatched';

@Entity({ name: 'publication_job_outbox' })
@Index('idx_publication_outbox_dispatch', ['status', 'availableAt', 'id'])
export class PublicationJobOutboxEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'publication_job_id', type: 'uuid', unique: true }) publicationJobId: string;
  @Column({ name: 'payload_version', type: 'integer', default: 1 }) payloadVersion: number;
  @Column({ type: 'text' }) status: PublicationOutboxStatus;
  @Column({ type: 'integer', default: 0 }) attempts: number;
  @Column({ name: 'available_at', type: 'timestamptz' }) availableAt: Date;
  @Column({ name: 'lease_token', type: 'uuid', nullable: true }) leaseToken: string | null;
  @Column({ name: 'lease_owner', type: 'text', nullable: true }) leaseOwner: string | null;
  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;
  @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true }) dispatchedAt: Date | null;
  @Column({ name: 'last_error_code', type: 'text', nullable: true }) lastErrorCode: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'publication_worker_state' })
export class PublicationWorkerStateEntity {
  @PrimaryColumn({ type: 'smallint' }) id: number;
  @Column({ name: 'worker_heartbeat_at', type: 'timestamptz', nullable: true })
  workerHeartbeatAt: Date | null;
  @Column({ name: 'last_dispatch_sweep_at', type: 'timestamptz', nullable: true })
  lastDispatchSweepAt: Date | null;
  @Column({ name: 'queue_depth', type: 'integer', default: 0 }) queueDepth: number;
  @Column({ name: 'oldest_queued_age_seconds', type: 'integer', default: 0 })
  oldestQueuedAgeSeconds: number;
  @Column({ name: 'building_count', type: 'integer', default: 0 }) buildingCount: number;
  @Column({ name: 'last_error_code', type: 'text', nullable: true }) lastErrorCode: string | null;
  @Column({ name: 'reconciliation_cursor_created_at', type: 'timestamptz', nullable: true })
  reconciliationCursorCreatedAt: Date | null;
  @Column({ name: 'reconciliation_cursor_job_id', type: 'uuid', nullable: true })
  reconciliationCursorJobId: string | null;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}
