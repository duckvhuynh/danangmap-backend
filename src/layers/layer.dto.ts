import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
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

const SOURCE_POLICIES = ['auto', 'geojson', 'mvt', 'hybrid'] as const;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export class LayerFieldValidationDto {
  @ApiProperty({ required: false, type: 'integer', minimum: 0, maximum: 10_000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  minLength?: number;

  @ApiProperty({ required: false, type: 'integer', minimum: 1, maximum: 10_000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxLength?: number;

  @ApiProperty({ required: false, type: 'number' })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  minimum?: number;

  @ApiProperty({ required: false, type: 'number' })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  maximum?: number;
}

export class PointStyleDto {
  @ApiProperty({ required: false, example: '#0068B5', pattern: '^#[0-9A-Fa-f]{6}$' })
  @IsOptional()
  @Matches(COLOR_PATTERN)
  color?: string;

  @ApiProperty({ required: false, type: 'number', minimum: 1, maximum: 64 })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(1)
  @Max(64)
  radius?: number;

  @ApiProperty({ required: false, example: '#FFFFFF', pattern: '^#[0-9A-Fa-f]{6}$' })
  @IsOptional()
  @Matches(COLOR_PATTERN)
  strokeColor?: string;

  @ApiProperty({ required: false, type: 'number', minimum: 0, maximum: 16 })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(16)
  strokeWidth?: number;

  @ApiProperty({ required: false, type: Boolean })
  @IsOptional()
  @IsBoolean()
  cluster?: boolean;
}

export class LineStyleDto {
  @ApiProperty({ required: false, example: '#0068B5', pattern: '^#[0-9A-Fa-f]{6}$' })
  @IsOptional()
  @Matches(COLOR_PATTERN)
  color?: string;

  @ApiProperty({ required: false, type: 'number', minimum: 0.5, maximum: 32 })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.5)
  @Max(32)
  width?: number;

  @ApiProperty({ required: false, type: 'number', minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  opacity?: number;
}

export class PolygonStyleDto {
  @ApiProperty({ required: false, example: '#DDEFFC', pattern: '^#[0-9A-Fa-f]{6}$' })
  @IsOptional()
  @Matches(COLOR_PATTERN)
  fillColor?: string;

  @ApiProperty({ required: false, type: 'number', minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  fillOpacity?: number;

  @ApiProperty({ required: false, example: '#0068B5', pattern: '^#[0-9A-Fa-f]{6}$' })
  @IsOptional()
  @Matches(COLOR_PATTERN)
  strokeColor?: string;

  @ApiProperty({ required: false, type: 'number', minimum: 0, maximum: 16 })
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(16)
  strokeWidth?: number;
}

export class LayerStyleDto {
  @ApiProperty({ required: false, type: () => PointStyleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PointStyleDto)
  point?: PointStyleDto;

  @ApiProperty({ required: false, type: () => LineStyleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LineStyleDto)
  line?: LineStyleDto;

  @ApiProperty({ required: false, type: () => PolygonStyleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PolygonStyleDto)
  polygon?: PolygonStyleDto;
}

export class LayerRenderConfigDto {
  @ApiProperty({ required: false, type: 'integer', minimum: 0, maximum: 24, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  minZoom?: number;

  @ApiProperty({ required: false, type: 'integer', minimum: 0, maximum: 24, default: 18 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  maxZoom?: number;

  @ApiProperty({ required: false, type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  cluster?: boolean;

  @ApiProperty({ required: false, enum: SOURCE_POLICIES, default: 'auto' })
  @IsOptional()
  @IsIn(SOURCE_POLICIES)
  sourcePolicy?: (typeof SOURCE_POLICIES)[number];
}

export class LayerPopupConfigDto {
  @ApiProperty({ required: false, pattern: '^[a-z][a-z0-9_]{1,63}$' })
  @IsOptional()
  @Matches(FIELD_KEY_PATTERN)
  titleField?: string;

  @ApiProperty({ required: false, pattern: '^[a-z][a-z0-9_]{1,63}$' })
  @IsOptional()
  @Matches(FIELD_KEY_PATTERN)
  subtitleField?: string;

  @ApiProperty({ required: false, type: 'array', items: { type: 'string' }, maxItems: 100 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Matches(FIELD_KEY_PATTERN, { each: true })
  fieldKeys?: string[];

  @ApiProperty({ required: false, type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  showCoordinates?: boolean;
}

export class LayerFieldDto {
  @ApiProperty({ example: 'address', pattern: '^[a-z][a-z0-9_]{1,63}$' })
  @Matches(FIELD_KEY_PATTERN)
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

  @ApiProperty({ required: false, type: () => LayerFieldValidationDto, default: {} })
  @ValidateIf((o, value) => value !== undefined)
  @ValidateNested()
  @Type(() => LayerFieldValidationDto)
  validation?: LayerFieldValidationDto;

  @ApiProperty({
    required: false,
    type: 'array',
    items: { type: 'string' },
    maxItems: 100,
    default: [],
  })
  @ValidateIf((o, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  options?: string[];

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

  @ApiProperty({ required: false, type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  defaultVisible: boolean = true;

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

  @ApiProperty({ required: false, type: () => LayerStyleDto, default: {} })
  @ValidateIf((o, value) => value !== undefined)
  @ValidateNested()
  @Type(() => LayerStyleDto)
  style?: LayerStyleDto;

  @ApiProperty({ required: false, type: () => LayerRenderConfigDto, default: {} })
  @ValidateIf((o, value) => value !== undefined)
  @ValidateNested()
  @Type(() => LayerRenderConfigDto)
  renderConfig?: LayerRenderConfigDto;

  @ApiProperty({ required: false, type: () => LayerPopupConfigDto, default: {} })
  @ValidateIf((o, value) => value !== undefined)
  @ValidateNested()
  @Type(() => LayerPopupConfigDto)
  popupConfig?: LayerPopupConfigDto;
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
