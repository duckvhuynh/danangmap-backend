import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import type { PublicationJobPhase, PublicationJobStatus } from './publication.entities';

export const PUBLICATION_JOB_STATUSES = ['queued', 'building', 'succeeded', 'failed'] as const;

export class PublicationJobListQueryDto {
  @ApiProperty({ required: false, enum: PUBLICATION_JOB_STATUSES })
  @IsOptional()
  @IsIn(PUBLICATION_JOB_STATUSES)
  status?: (typeof PUBLICATION_JOB_STATUSES)[number];

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  revisionId?: string;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  cursor?: string;

  @ApiProperty({ required: false, type: 'integer', minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;
}

export interface PublicationJobView {
  id: string;
  layerId: string;
  revisionId: string;
  status: PublicationJobStatus;
  phase: PublicationJobPhase;
  progress: {
    completedUnits: number;
    totalUnits: number | null;
    unit: 'features';
    percent: number | null;
  };
  attempt: number;
  result: { snapshotId: string; generation: number } | null;
  failure: {
    code: string;
    userMessage: string;
    requestId: string | null;
    retryable: boolean;
  } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface PublicationJobPage {
  items: PublicationJobView[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}
