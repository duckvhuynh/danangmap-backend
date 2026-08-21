import { Module } from '@nestjs/common';
import { PublicApiModule } from '../public-api/public-api.module';
import { HealthController } from './health.controller';

@Module({ imports: [PublicApiModule], controllers: [HealthController] })
export class HealthModule {}
