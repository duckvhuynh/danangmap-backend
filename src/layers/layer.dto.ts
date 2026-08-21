import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({ example: 'address', pattern: '^[a-z][a-z0-9_]{1,63}$' })
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  key: string;

  @ApiProperty({ example: 'Địa chỉ', minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  label: string;

  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Length(0, 1_000)
  description?: string;

  @ApiProperty({ enum: FIELD_TYPES })
  @IsIn(FIELD_TYPES)
  type: string;

  @ApiProperty({ required: false, example: 'map-pin', maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  icon?: string;

  @ApiProperty({ required: false, type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  required: boolean = false;

  @ApiProperty({ required: false, type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  public: boolean = true;

  @ApiProperty({ required: false, type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  searchable: boolean = false;

  @ApiProperty({ required: false, type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  filterable: boolean = false;

  @ApiProperty({ required: false, type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  sortable: boolean = false;

  @ApiProperty({ required: false, type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  sensitive: boolean = false;

  @ApiProperty({ required: false, type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  offlineCache: boolean = true;

  @ApiProperty({
    required: false,
    nullable: true,
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'object', additionalProperties: true },
      { type: 'array', items: {} },
    ],
  })
  @IsOptional()
  defaultValue?: unknown;

  @ApiProperty({ required: false, type: Object, additionalProperties: true, default: {} })
  @IsOptional()
  @IsObject()
  validation: Record<string, unknown> = {};

  @ApiProperty({ required: false, type: 'array', items: {}, maxItems: 100, default: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  options: unknown[] = [];

  @ApiProperty({ required: false, type: 'integer', default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder: number = 0;
}

export class CreateLayerGroupDto {
  @ApiProperty({ example: 'government', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug: string;

  @ApiProperty({ example: 'Cơ quan hành chính', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title: string;

  @ApiProperty({ required: false, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(0, 2_000)
  description?: string;

  @ApiProperty({ required: false, type: 'integer', default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder: number = 0;

  @ApiProperty({ required: false, type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  defaultVisible: boolean = true;
}

export class CreateLayerDto {
  @ApiProperty({ example: 'administrative-offices', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  slug: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiProperty({ required: false, type: 'integer', default: 0 })
  @IsOptional()
  @IsInt()
  displayOrder: number = 0;

  @ApiProperty({ example: 'Trụ sở hành chính', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title: string;

  @ApiProperty({ required: false, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(0, 2_000)
  description?: string;

  @ApiProperty({ enum: GEOMETRY_MODES })
  @IsIn(GEOMETRY_MODES)
  geometryMode: GeometryMode;

  @ApiProperty({ type: 'array', enum: GEOMETRY_KINDS, isArray: true, minItems: 1, maxItems: 7 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsIn(GEOMETRY_KINDS, { each: true })
  allowedGeometryKinds: GeometryKind[];

  @ApiProperty({ type: () => LayerFieldDto, isArray: true, minItems: 1, maxItems: 100 })
  @ValidateNested({ each: true })
  @Type(() => LayerFieldDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  fields: LayerFieldDto[];

  @ApiProperty({ required: false, type: Object, additionalProperties: true, default: {} })
  @IsOptional()
  @IsObject()
  style: Record<string, unknown> = {};

  @ApiProperty({ required: false, type: Object, additionalProperties: true, default: {} })
  @IsOptional()
  @IsObject()
  renderConfig: Record<string, unknown> = {};

  @ApiProperty({ required: false, type: Object, additionalProperties: true, default: {} })
  @IsOptional()
  @IsObject()
  popupConfig: Record<string, unknown> = {};
}

export class FeatureMutationDto {
  @ApiProperty({
    type: Object,
    additionalProperties: true,
    example: { type: 'Point', coordinates: [108.2208, 16.0678] },
  })
  @IsObject()
  geometry: Record<string, unknown>;

  @ApiProperty({ enum: GEOMETRY_KINDS })
  @IsIn(GEOMETRY_KINDS)
  geometryKind: GeometryKind;

  @ApiProperty({
    required: false,
    type: 'number',
    nullable: true,
    minimum: 0.001,
    maximum: 10000000,
  })
  @IsOptional()
  @Min(0.001)
  @Max(10_000_000)
  radiusM?: number | null;

  @ApiProperty({ required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  externalSource?: string;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  externalId?: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  @IsObject()
  properties: Record<string, unknown>;
}

export class UpdateFeatureDto {
  @ApiProperty({ required: false, type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  geometry?: Record<string, unknown>;

  @ApiProperty({ required: false, enum: GEOMETRY_KINDS })
  @IsOptional()
  @IsIn(GEOMETRY_KINDS)
  geometryKind?: GeometryKind;

  @ApiProperty({
    required: false,
    type: 'number',
    nullable: true,
    minimum: 0.001,
    maximum: 10000000,
  })
  @IsOptional()
  @Min(0.001)
  @Max(10_000_000)
  radiusM?: number | null;

  @ApiProperty({ required: false, type: Object, additionalProperties: true })
  @IsOptional()
  @IsObject()
  properties?: Record<string, unknown>;
}

export class WorkflowCommentDto {
  @ApiProperty({ required: false, maxLength: 4000 })
  @IsOptional()
  @IsString()
  @Length(1, 4_000)
  comment?: string;
}

export class RequestChangesDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @Length(1, 4_000)
  comment: string;
}

export class SubmitRevisionDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @Length(1, 4_000)
  summary: string;

  @ApiProperty({ required: false, maxLength: 4000 })
  @IsOptional()
  @IsString()
  @Length(0, 4_000)
  reviewerNote?: string;
}

export class PublishRevisionDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @Length(1, 4_000)
  releaseNote: string;
}

export class RollbackDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetSnapshotId: string;

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @Length(1, 4_000)
  reason: string;
}
