import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class ValidateUserImportDto {
  @ApiProperty({
    required: false,
    minLength: 1,
    maxLength: 100,
    description: 'Required when an XLSX workbook contains more than one worksheet.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  sheet?: string;
}

export class ApplyUserImportDto {
  @ApiProperty({ enum: ['invite'], default: 'invite' })
  @IsIn(['invite'])
  validRowPolicy: 'invite';
}
