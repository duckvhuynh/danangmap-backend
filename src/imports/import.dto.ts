import { IsIn, IsOptional, IsUUID } from 'class-validator';
import type { ImportFormat, ImportMode } from '../domain/enums';

export class CreateImportDto {
  @IsOptional()
  @IsIn(['csv', 'xlsx', 'geojson', 'kml'])
  format?: ImportFormat;

  @IsIn(['append', 'replace', 'upsert'])
  mode: ImportMode;

  @IsUUID()
  clientRequestId: string;
}
