import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import type { ImportFormat, ImportMode } from '../domain/enums';

export class CreateImportDto {
  @ApiProperty({ required: false, enum: ['csv', 'xlsx', 'geojson', 'kml'] })
  @IsOptional()
  @IsIn(['csv', 'xlsx', 'geojson', 'kml'])
  format?: ImportFormat;

  @ApiProperty({ enum: ['append', 'replace', 'upsert'] })
  @IsIn(['append', 'replace', 'upsert'])
  mode: ImportMode;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  clientRequestId: string;
}
