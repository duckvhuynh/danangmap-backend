import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { RequestIdMiddleware } from './common/http/request-id.middleware';
import { StorageModule } from './storage/storage.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AuditModule } from './audit/audit.module';
import { IdentityModule } from './identity/identity.module';
import { LayersModule } from './layers/layers.module';
import { PublicApiModule } from './public-api/public-api.module';
import { ImportsModule } from './imports/imports.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';

@Module({
  imports: [
    AppConfigModule,
    IdempotencyModule,
    DatabaseModule,
    CryptoModule,
    StorageModule,
    JobsModule,
    AuditModule,
    IdentityModule,
    LayersModule,
    PublicApiModule,
    ImportsModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
