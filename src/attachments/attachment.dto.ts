import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAttachmentUploadDto {
  @IsIn(['feature_attachment']) purpose: 'feature_attachment';

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  contentType: string;

  @IsInt()
  @Min(1)
  sizeBytes: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @Matches(/^[0-9a-f]{64}$/)
  sha256: string;
}

export class BindAttachmentDto {
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]{1,63}$' })
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  fieldKey: string;
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  attachmentId: string;
  @ApiProperty({ minimum: 0, maximum: 100_000, default: 0 })
  @IsInt()
  @Min(0)
  @Max(100_000)
  displayOrder = 0;
}

export class ReorderAttachmentsDto {
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]{1,63}$' })
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  fieldKey: string;
  @ApiProperty({ type: [String], format: 'uuid', maxItems: 100, uniqueItems: true })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  attachmentIds: string[];
}
