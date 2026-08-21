import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { CsrfGuard, PreAuthGuard, RolesGuard, SessionGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { UsersController } from './users.controller';
import {
  AdminSessionEntity,
  InviteEntity,
  MailOutboxEntity,
  UserEntity,
} from './identity.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, AdminSessionEntity, InviteEntity, MailOutboxEntity]),
  ],
  controllers: [AuthController, UsersController],
  providers: [AuthService, SessionGuard, PreAuthGuard, RolesGuard, CsrfGuard],
  exports: [SessionGuard, RolesGuard, CsrfGuard, TypeOrmModule],
})
export class IdentityModule {}
