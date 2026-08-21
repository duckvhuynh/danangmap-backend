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
import { UsersController } from './users.controller';
import {
  AdminSessionEntity,
  InviteEntity,
  MailOutboxEntity,
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
    ]),
  ],
  controllers: [AuthController, UsersController],
  providers: [AuthService, SessionGuard, PreAuthGuard, OptionalAuthGuard, RolesGuard, CsrfGuard],
  exports: [SessionGuard, RolesGuard, CsrfGuard, TypeOrmModule],
})
export class IdentityModule {}
