import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
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

export class ImportGeometryMappingDto {
  @ApiProperty({ enum: ['geojson', 'coordinates', 'wkt', 'kml_geometry'] })
  @IsIn(['geojson', 'coordinates', 'wkt', 'kml_geometry'])
  kind: 'geojson' | 'coordinates' | 'wkt' | 'kml_geometry';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  longitudeColumn?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  latitudeColumn?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  geometryColumn?: string;
}

export class ImportUpsertMappingDto {
  @ApiProperty({ enum: ['external_identity'] })
  @IsIn(['external_identity'])
  matchBy: 'external_identity';
}

export class UpdateImportMappingDto {
  @ApiProperty({ required: false, type: String, enum: ['EPSG:4326'], example: 'EPSG:4326' })
  @IsOptional()
  @Matches(/^EPSG:4326$/)
  sourceCrs: string = 'EPSG:4326';

  @ApiProperty({ type: () => ImportGeometryMappingDto })
  @ValidateNested()
  @Type(() => ImportGeometryMappingDto)
  geometry: ImportGeometryMappingDto;

  @ApiProperty({ type: Object, additionalProperties: { type: 'string' } })
  @IsObject()
  fields: Record<string, string>;

  @ApiProperty({ enum: ['ignore'], default: 'ignore' })
  @IsIn(['ignore'])
  unmappedColumnPolicy = 'ignore' as const;

  @ApiProperty({ required: false, type: () => ImportUpsertMappingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ImportUpsertMappingDto)
  upsert?: ImportUpsertMappingDto;
}

export class ApplyImportDto {
  @ApiProperty({ default: false })
  @IsBoolean()
  skipInvalid: boolean;

  @ApiProperty({ required: false, type: [String], default: [] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  acknowledgedWarningCodes: string[] = [];
}
