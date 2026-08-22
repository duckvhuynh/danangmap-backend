import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { REVISION_STATUSES } from '../domain/enums';

export class HistoryPageQueryDto {
  @ApiProperty({ required: false, type: 'integer', minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  cursor?: string;
}

export class RevisionHistoryQueryDto extends HistoryPageQueryDto {
  @ApiProperty({ required: false, enum: REVISION_STATUSES })
  @IsOptional()
  @IsIn(REVISION_STATUSES)
  status?: (typeof REVISION_STATUSES)[number];
}

export class RevisionDiffQueryDto {
  @ApiProperty({ required: false, enum: ['parent', 'active'], default: 'parent' })
  @IsOptional()
  @IsIn(['parent', 'active'])
  compareTo: 'parent' | 'active' = 'parent';

  @ApiProperty({ required: false, type: 'integer', minimum: 1, maximum: 25, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit: number = 25;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  cursor?: string;
}

export class PublicationHistoryQueryDto extends HistoryPageQueryDto {
  @ApiProperty({ required: false, enum: ['building', 'published', 'failed'] })
  @IsOptional()
  @IsIn(['building', 'published', 'failed'])
  status?: 'building' | 'published' | 'failed';

  @ApiProperty({ required: false, enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  rollbackOnly?: 'true' | 'false';
}

export class AuditHistoryQueryDto extends HistoryPageQueryDto {
  @ApiProperty({ required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  action?: string;

  @ApiProperty({ required: false, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  resourceType?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  requestId?: string;

  @ApiProperty({ required: false, format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiProperty({ required: false, format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class WorkflowHistoryQueryDto extends HistoryPageQueryDto {}
