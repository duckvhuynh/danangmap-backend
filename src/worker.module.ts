import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { JobsModule } from './jobs/jobs.module';
import { StorageModule } from './storage/storage.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { ImportsWorkerModule } from './imports/imports-worker.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { UserImportsWorkerModule } from './user-imports/user-imports-worker.module';
import { MailWorkerModule } from './mail/mail-worker.module';
import { PublicationsWorkerModule } from './publications/publications-worker.module';
import { AttachmentsWorkerModule } from './attachments/attachments-worker.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    CryptoModule,
    IdempotencyModule,
    StorageModule,
    JobsModule,
    ImportsWorkerModule,
    UserImportsWorkerModule,
    MailWorkerModule,
    PublicationsWorkerModule,
    AttachmentsWorkerModule,
  ],
})
export class WorkerModule {}
