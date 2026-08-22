import type { Geometry } from 'geojson';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { GeometryKind, GeometryMode, RevisionStatus } from '../domain/enums';

@Entity({ name: 'layer_groups' })
@Index('uq_layer_groups_slug_active', ['slug'], { unique: true, where: 'archived_at IS NULL' })
export class LayerGroupEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) slug: string;
  @Column({ type: 'text' }) title: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ name: 'display_order', type: 'integer', default: 0 }) displayOrder: number;
  @Column({ name: 'default_visible', type: 'boolean', default: true }) defaultVisible: boolean;
  @Column({ name: 'lock_version', type: 'integer', default: 1 }) lockVersion: number;
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true }) archivedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'layers' })
@Index('uq_layers_slug_active', ['slug'], { unique: true, where: 'archived_at IS NULL' })
export class LayerEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) slug: string;
  @Column({ name: 'group_id', type: 'uuid', nullable: true }) groupId: string | null;
  @Column({ name: 'display_order', type: 'integer', default: 0 }) displayOrder: number;
  @Column({ name: 'default_visible', type: 'boolean', default: true }) defaultVisible: boolean;
  @Column({ name: 'lock_version', type: 'integer', default: 1 }) lockVersion: number;
  @Column({ name: 'created_by', type: 'uuid' }) createdBy: string;
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true }) archivedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'layer_revisions' })
@Index('uq_layer_revision_number', ['layerId', 'revisionNo'], { unique: true })
@Index('uq_layer_open_editorial_chain', ['layerId'], {
  unique: true,
  where: "status IN ('draft','in_review','approved','publishing')",
})
export class LayerRevisionEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'layer_id', type: 'uuid' }) layerId: string;
  @Column({ name: 'revision_no', type: 'integer' }) revisionNo: number;
  @Column({ type: 'text' }) status: RevisionStatus;
  @Column({ type: 'text' }) title: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ name: 'geometry_mode', type: 'text' }) geometryMode: GeometryMode;
  @Column({ name: 'allowed_geometry_kinds', type: 'text', array: true })
  allowedGeometryKinds: GeometryKind[];
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) style: Record<string, unknown>;
  @Column({ name: 'render_config', type: 'jsonb', default: () => "'{}'::jsonb" })
  renderConfig: Record<string, unknown>;
  @Column({ name: 'popup_config', type: 'jsonb', default: () => "'{}'::jsonb" })
  popupConfig: Record<string, unknown>;
  @Column({ name: 'schema_version', type: 'integer', default: 1 }) schemaVersion: number;
  @Column({ name: 'lock_version', type: 'integer', default: 1 }) lockVersion: number;
  @Column({ name: 'cursor_seq', type: 'bigint', default: 0 }) cursorSeq: string;
  @Column({ name: 'created_by', type: 'uuid' }) createdBy: string;
  @Column({ name: 'supersedes_revision_id', type: 'uuid', nullable: true }) supersedesRevisionId:
    string | null;
  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true }) submittedAt: Date | null;
  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true }) approvedAt: Date | null;
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true }) publishedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

@Entity({ name: 'layer_fields' })
@Index('uq_layer_fields_key', ['revisionId', 'key'], { unique: true })
export class LayerFieldEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @Column({ type: 'text' }) key: string;
  @Column({ type: 'text' }) label: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'text' }) type: string;
  @Column({ type: 'text', nullable: true }) icon: string | null;
  @Column({ type: 'boolean', default: false }) required: boolean;
  @Column({ type: 'boolean', default: true }) public: boolean;
  @Column({ type: 'boolean', default: false }) searchable: boolean;
  @Column({ type: 'boolean', default: false }) filterable: boolean;
  @Column({ type: 'boolean', default: false }) sortable: boolean;
  @Column({ type: 'boolean', default: false }) sensitive: boolean;
  @Column({ name: 'offline_cache', type: 'boolean', default: true }) offlineCache: boolean;
  @Column({ name: 'default_value', type: 'jsonb', nullable: true }) defaultValue: unknown;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) validation: Record<string, unknown>;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) options: unknown[];
  @Column({ name: 'display_order', type: 'integer', default: 0 }) displayOrder: number;
}

@Entity({ name: 'features' })
@Index('uq_features_external_identity', ['layerId', 'externalSource', 'externalId'], {
  unique: true,
  where: 'external_source IS NOT NULL AND external_id IS NOT NULL AND deleted_at IS NULL',
})
export class FeatureEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'layer_id', type: 'uuid' }) layerId: string;
  @Column({ name: 'external_source', type: 'text', nullable: true }) externalSource: string | null;
  @Column({ name: 'external_id', type: 'text', nullable: true }) externalId: string | null;
  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true }) deletedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity({ name: 'feature_versions' })
@Index('idx_feature_versions_geometry', ['geometry'], { spatial: true })
export class FeatureVersionEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'feature_id', type: 'uuid' }) featureId: string;
  @Column({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @Column({ type: 'geometry', spatialFeatureType: 'Geometry', srid: 4326 }) geometry: Geometry;
  @Column({ name: 'geometry_kind', type: 'text' }) geometryKind: GeometryKind;
  @Column({ type: 'jsonb' }) properties: Record<string, unknown>;
  @Column({ name: 'radius_m', type: 'double precision', nullable: true }) radiusM: number | null;
  @Column({ type: 'text' }) checksum: string;
  @Column({ name: 'created_by', type: 'uuid' }) createdBy: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}

@Entity({ name: 'revision_features' })
export class RevisionFeatureEntity {
  @PrimaryColumn({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @PrimaryColumn({ name: 'feature_id', type: 'uuid' }) featureId: string;
  @Column({ name: 'feature_version_id', type: 'uuid' }) featureVersionId: string;
  @Column({ type: 'integer', default: 0 }) ordinal: number;
}

@Entity({ name: 'revision_changes' })
@Index('uq_revision_cursor', ['revisionId', 'serverCursor'], { unique: true })
export class RevisionChangeEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @Column({ name: 'server_cursor', type: 'bigint' }) serverCursor: string;
  @Column({ type: 'text' }) operation: string;
  @Column({ name: 'feature_id', type: 'uuid' }) featureId: string;
  @Column({ name: 'version_id', type: 'uuid', nullable: true }) versionId: string | null;
  @Column({ name: 'changed_paths', type: 'text', array: true, default: () => "'{}'::text[]" })
  changedPaths: string[];
  @Column({ name: 'actor_id', type: 'uuid' }) actorId: string;
  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' }) changedAt: Date;
}

@Entity({ name: 'client_mutations' })
@Index('uq_client_mutation', ['revisionId', 'clientId', 'mutationId'], { unique: true })
export class ClientMutationEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'revision_id', type: 'uuid' }) revisionId: string;
  @Column({ name: 'client_id', type: 'text' }) clientId: string;
  @Column({ name: 'mutation_id', type: 'uuid' }) mutationId: string;
  @Column({ name: 'request_digest', type: 'text' }) requestDigest: string;
  @Column({ name: 'response_payload', type: 'jsonb' }) responsePayload: Record<string, unknown>;
  @Column({ name: 'server_cursor', type: 'bigint' }) serverCursor: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
