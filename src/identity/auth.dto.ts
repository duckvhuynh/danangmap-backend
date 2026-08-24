import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
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
import { Type } from 'class-transformer';
import { USER_ROLES, USER_STATUSES, type UserRole, type UserStatus } from '../domain/enums';

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

export class ConfirmMfaEnrollmentDto {
  @ApiProperty({ writeOnly: true, minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/)
  code: string;
}

export class InspectInviteDto {
  @ApiProperty({ writeOnly: true, minLength: 32, maxLength: 512 })
  @IsString()
  @Length(32, 512)
  @Matches(/^[A-Za-z0-9_-]+$/)
  token: string;
}

export class AcceptInviteDto extends InspectInviteDto {
  @ApiProperty({ writeOnly: true, minLength: 12, maxLength: 200 })
  @IsString()
  @Length(12, 200)
  password: string;

  @ApiProperty({ writeOnly: true, minLength: 12, maxLength: 200 })
  @IsString()
  @Length(12, 200)
  passwordConfirmation: string;
}

export class ChangePasswordDto {
  @ApiProperty({ writeOnly: true, minLength: 12, maxLength: 200 })
  @IsString()
  @Length(12, 200)
  currentPassword: string;

  @ApiProperty({ writeOnly: true, minLength: 12, maxLength: 200 })
  @IsString()
  @Length(12, 200)
  newPassword: string;

  @ApiProperty({ writeOnly: true, minLength: 12, maxLength: 200 })
  @IsString()
  @Length(12, 200)
  passwordConfirmation: string;
}

export class PasswordResetRequestDto {
  @ApiProperty({ example: 'editor@example.gov.vn', maxLength: 254 })
  @IsEmail()
  @Length(3, 254)
  email: string;
}

export class PasswordResetConfirmDto {
  @ApiProperty({ writeOnly: true, minLength: 32, maxLength: 512 })
  @IsString()
  @Length(32, 512)
  @Matches(/^[A-Za-z0-9_-]+$/)
  token: string;

  @ApiProperty({ writeOnly: true, minLength: 12, maxLength: 200 })
  @IsString()
  @Length(12, 200)
  password: string;

  @ApiProperty({ writeOnly: true, minLength: 12, maxLength: 200 })
  @IsString()
  @Length(12, 200)
  passwordConfirmation: string;
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

export class ListUsersQueryDto {
  @ApiProperty({ required: false, minLength: 2, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  q?: string;

  @ApiProperty({ required: false, enum: USER_ROLES })
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;

  @ApiProperty({ required: false, enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;

  @ApiProperty({ required: false, type: String })
  @IsOptional()
  @IsString()
  @Length(8, 512)
  cursor?: string;

  @ApiProperty({ required: false, type: 'integer', default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

export class ListInvitesQueryDto {
  @ApiProperty({ required: false, minLength: 2, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(2, 100)
  q?: string;

  @ApiProperty({ required: false, enum: ['pending', 'expired', 'revoked', 'accepted'] })
  @IsOptional()
  @IsIn(['pending', 'expired', 'revoked', 'accepted'])
  status?: 'pending' | 'expired' | 'revoked' | 'accepted';

  @ApiProperty({ required: false, enum: USER_ROLES })
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;

  @ApiProperty({ required: false, type: String })
  @IsOptional()
  @IsString()
  @Length(8, 512)
  cursor?: string;

  @ApiProperty({ required: false, type: 'integer', default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

export class UpdateUserDto {
  @ApiProperty({ required: false, minLength: 2, maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  displayName?: string;

  @ApiProperty({ required: false, enum: USER_ROLES })
  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;

  @ApiProperty({ required: false, enum: ['active', 'disabled'] })
  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: Extract<UserStatus, 'active' | 'disabled'>;

  @ApiProperty({ required: false, minLength: 3, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  unlock?: boolean;
}

export class AdminReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reason: string;
}

export class ResendInviteDto extends AdminReasonDto {
  @ApiProperty({ required: false, type: 'integer', default: 72, minimum: 1, maximum: 168 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  expiresInHours: number = 72;
}
