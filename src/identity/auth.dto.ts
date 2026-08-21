import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { USER_ROLES, type UserRole } from '../domain/enums';

export class LoginDto {
  @ApiProperty({ example: 'editor@example.gov.vn' })
  @IsString()
  @Length(3, 254)
  login: string;

  @ApiProperty({ writeOnly: true })
  @IsString()
  @Length(12, 200)
  password: string;
}

export class VerifyMfaDto {
  @ApiProperty({ enum: ['totp', 'recovery_code'], default: 'totp' })
  @IsIn(['totp', 'recovery_code'])
  method: 'totp' | 'recovery_code';

  @ApiProperty({ writeOnly: true })
  @IsString()
  @Length(6, 64)
  code: string;
}

export class CreateUserDto {
  @ApiProperty({ example: 'editor@example.gov.vn' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'editor01', pattern: '^[a-z][a-z0-9._-]{2,63}$' })
  @Matches(/^[a-z][a-z0-9._-]{2,63}$/)
  username: string;

  @ApiProperty({ example: 'Biên tập viên 01', minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200)
  displayName: string;

  @ApiProperty({ enum: USER_ROLES })
  @IsIn(USER_ROLES)
  role: UserRole;

  @ApiProperty({ enum: ['manual', 'invite'] })
  @IsIn(['manual', 'invite'])
  delivery: 'manual' | 'invite';

  @ApiProperty({ required: false, writeOnly: true, minLength: 12 })
  @IsOptional()
  @IsString()
  @MinLength(12)
  temporaryPassword?: string;
}

export class CreateInviteDto {
  @ApiProperty({ example: 'reviewer@example.gov.vn' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'reviewer01', pattern: '^[a-z][a-z0-9._-]{2,63}$' })
  @Matches(/^[a-z][a-z0-9._-]{2,63}$/)
  username: string;

  @ApiProperty({ example: 'Kiểm duyệt viên 01', minLength: 2, maxLength: 200 })
  @IsString()
  @Length(2, 200)
  displayName: string;

  @ApiProperty({ enum: USER_ROLES })
  @IsIn(USER_ROLES)
  role: UserRole;

  @ApiProperty({
    required: false,
    type: 'integer',
    default: 72,
    minimum: 1,
    maximum: 168,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  expiresInHours: number = 72;
}
