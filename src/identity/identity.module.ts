import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import {
  CsrfGuard,
  OptionalAuthGuard,
  PreAuthGuard,
  RolesGuard,
  SessionGuard,
} from './auth.guards';
import { AuthService } from './auth.service';
import { AdminIdentityService } from './admin-identity.service';
import { UsersController } from './users.controller';
import { IdentityRateLimitService } from './identity-rate-limit.service';
import { PasswordSecurityService } from './password-security.service';
import {
  AdminSessionEntity,
  InviteEntity,
  MailOutboxEntity,
  PasswordResetTokenEntity,
  UserMfaMethodEntity,
  UserMfaRecoveryCodeEntity,
  UserEntity,
} from './identity.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      AdminSessionEntity,
      UserMfaMethodEntity,
      UserMfaRecoveryCodeEntity,
      InviteEntity,
      MailOutboxEntity,
      PasswordResetTokenEntity,
    ]),
  ],
  controllers: [AuthController, UsersController],
  providers: [
    AuthService,
    AdminIdentityService,
    IdentityRateLimitService,
    PasswordSecurityService,
    SessionGuard,
    PreAuthGuard,
    OptionalAuthGuard,
    RolesGuard,
    CsrfGuard,
  ],
  exports: [SessionGuard, RolesGuard, CsrfGuard, TypeOrmModule],
})
export class IdentityModule {}
