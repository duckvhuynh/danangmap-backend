import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'revision_participants' })
export class RevisionParticipantEntity {
  @PrimaryColumn({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @PrimaryColumn({ name: 'user_id', type: 'uuid' }) userId: string;
  @PrimaryColumn({ name: 'participation_type', type: 'text' }) participationType:
    'edit' | 'review' | 'publish';
  @CreateDateColumn({ name: 'participated_at', type: 'timestamptz' }) participatedAt: Date;
}

@Entity({ name: 'workflow_events' })
@Index('idx_workflow_events_revision', ['revisionId', 'occurredAt'])
export class WorkflowEventEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @Column({ name: 'from_status', type: 'text' }) fromStatus: string;
  @Column({ name: 'to_status', type: 'text' }) toStatus: string;
  @Column({ name: 'actor_id', type: 'uuid' }) actorId: string;
  @Column({ type: 'text', nullable: true }) reason: string | null;
  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' }) occurredAt: Date;
}

@Entity({ name: 'publication_snapshots' })
@Index('uq_publication_generation', ['layerId', 'generation'], { unique: true })
export class PublicationSnapshotEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'layer_id', type: 'uuid' }) layerId: string;
  @Column({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @Column({ type: 'text' }) status: 'building' | 'published' | 'failed';
  @Column({ type: 'bigint' }) generation: string;
  @Column({ name: 'feature_count', type: 'integer', default: 0 }) featureCount: number;
  @Column({ type: 'double precision', array: true, nullable: true }) bounds: number[] | null;
  @Column({ type: 'text' }) checksum: string;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) manifest: Record<string, unknown>;
  @Column({ name: 'published_by', type: 'uuid' }) publishedBy: string;
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity({ name: 'layer_publications' })
export class LayerPublicationEntity {
  @PrimaryColumn({ name: 'layer_id', type: 'uuid' }) layerId: string;
  @Column({ name: 'active_snapshot_id', type: 'uuid' }) activeSnapshotId: string;
  @Column({ name: 'previous_snapshot_id', type: 'uuid', nullable: true }) previousSnapshotId:
    string | null;
  @Column({ name: 'pointer_updated_at', type: 'timestamptz' }) pointerUpdatedAt: Date;
}
