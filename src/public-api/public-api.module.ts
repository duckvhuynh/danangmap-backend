import { Module } from '@nestjs/common';
import { GeoServiceAdapter } from './geo-service.adapter';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';

@Module({
  controllers: [PublicApiController],
  providers: [GeoServiceAdapter, PublicApiService],
  exports: [GeoServiceAdapter],
})
export class PublicApiModule {}
