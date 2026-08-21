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
  @IsEmail()
  email: string;

  @Matches(/^[a-z][a-z0-9._-]{2,63}$/)
  username: string;

  @IsString()
  @Length(2, 200)
  displayName: string;

  @IsIn(USER_ROLES)
  role: UserRole;

  @IsIn(['manual', 'invite'])
  delivery: 'manual' | 'invite';

  @IsOptional()
  @IsString()
  @MinLength(12)
  temporaryPassword?: string;
}

export class CreateInviteDto {
  @IsEmail()
  email: string;

  @Matches(/^[a-z][a-z0-9._-]{2,63}$/)
  username: string;

  @IsString()
  @Length(2, 200)
  displayName: string;

  @IsIn(USER_ROLES)
  role: UserRole;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  expiresInHours = 72;
}
