import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  GEOMETRY_KINDS,
  GEOMETRY_MODES,
  type GeometryKind,
  type GeometryMode,
} from '../domain/enums';

const FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'url',
  'email',
  'phone',
  'enum',
  'multi_enum',
  'address',
  'image',
  'attachment',
] as const;

export class LayerFieldDto {
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  key: string;

  @IsString()
  @Length(1, 200)
  label: string;

  @IsOptional()
  @IsString()
  @Length(0, 1_000)
  description?: string;

  @IsIn(FIELD_TYPES)
  type: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  icon?: string;

  @IsOptional()
  @IsBoolean()
  required = false;

  @IsOptional()
  @IsBoolean()
  public = true;

  @IsOptional()
  @IsBoolean()
  searchable = false;

  @IsOptional()
  @IsBoolean()
  filterable = false;

  @IsOptional()
  @IsBoolean()
  sortable = false;

  @IsOptional()
  @IsBoolean()
  sensitive = false;

  @IsOptional()
  @IsBoolean()
  offlineCache = true;

  @IsOptional()
  defaultValue?: unknown;

  @IsOptional()
  @IsObject()
  validation: Record<string, unknown> = {};

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  options: unknown[] = [];

  @IsOptional()
  @IsInt()
  displayOrder = 0;
}

export class CreateLayerGroupDto {
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug: string;

  @IsString()
  @Length(1, 200)
  title: string;

  @IsOptional()
  @IsString()
  @Length(0, 2_000)
  description?: string;

  @IsOptional()
  @IsInt()
  displayOrder = 0;

  @IsOptional()
  @IsBoolean()
  defaultVisible = true;
}

export class CreateLayerDto {
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  @IsOptional()
  @IsInt()
  displayOrder = 0;

  @IsString()
  @Length(1, 200)
  title: string;

  @IsOptional()
  @IsString()
  @Length(0, 2_000)
  description?: string;

  @IsIn(GEOMETRY_MODES)
  geometryMode: GeometryMode;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsIn(GEOMETRY_KINDS, { each: true })
  allowedGeometryKinds: GeometryKind[];

  @ValidateNested({ each: true })
  @Type(() => LayerFieldDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  fields: LayerFieldDto[];

  @IsOptional()
  @IsObject()
  style: Record<string, unknown> = {};

  @IsOptional()
  @IsObject()
  renderConfig: Record<string, unknown> = {};

  @IsOptional()
  @IsObject()
  popupConfig: Record<string, unknown> = {};
}

export class FeatureMutationDto {
  @IsObject()
  geometry: Record<string, unknown>;

  @IsIn(GEOMETRY_KINDS)
  geometryKind: GeometryKind;

  @IsOptional()
  @Min(0.001)
  @Max(10_000_000)
  radiusM?: number | null;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  externalSource?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  externalId?: string;

  @IsObject()
  properties: Record<string, unknown>;
}

export class UpdateFeatureDto {
  @IsOptional()
  @IsObject()
  geometry?: Record<string, unknown>;

  @IsOptional()
  @IsIn(GEOMETRY_KINDS)
  geometryKind?: GeometryKind;

  @IsOptional()
  @Min(0.001)
  @Max(10_000_000)
  radiusM?: number | null;

  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}

export class WorkflowCommentDto {
  @IsOptional()
  @IsString()
  @Length(1, 4_000)
  comment?: string;
}

export class RequestChangesDto {
  @IsString()
  @Length(1, 4_000)
  comment: string;
}

export class SubmitRevisionDto {
  @IsString()
  @Length(1, 4_000)
  summary: string;

  @IsOptional()
  @IsString()
  @Length(0, 4_000)
  reviewerNote?: string;
}

export class PublishRevisionDto {
  @IsString()
  @Length(1, 4_000)
  releaseNote: string;
}

export class RollbackDto {
  @IsUUID()
  targetSnapshotId: string;

  @IsString()
  @Length(1, 4_000)
  reason: string;
}
