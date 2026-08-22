import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InviteEntity, MailOutboxEntity } from '../identity/identity.entities';
import {
  UserImportInviteEntity,
  UserImportIssueEntity,
  UserImportJobEntity,
  UserImportRowEntity,
} from './user-import.entity';
import { UserImportProcessor } from './user-import.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserImportJobEntity,
      UserImportRowEntity,
      UserImportIssueEntity,
      UserImportInviteEntity,
      InviteEntity,
      MailOutboxEntity,
    ]),
  ],
  providers: [UserImportProcessor],
})
export class UserImportsWorkerModule {}
