import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { JobsModule } from './jobs/jobs.module';
import { StorageModule } from './storage/storage.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { ImportsWorkerModule } from './imports/imports-worker.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    CryptoModule,
    StorageModule,
    JobsModule,
    ImportsWorkerModule,
  ],
})
export class WorkerModule {}
