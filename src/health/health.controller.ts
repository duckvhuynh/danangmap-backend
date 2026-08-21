import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { StorageService } from '../storage/storage.service';
import { RawResponse } from '../common/http/raw-response.decorator';
import {
  apiRawJsonResponse,
  livenessSchema,
  readinessSchema,
} from '../common/openapi/response-schemas';

@ApiTags('health')
@Controller('health')
@RawResponse()
export class HealthController {
  private readonly redis: Redis;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {
    this.redis = new Redis({
      host: config.getOrThrow<string>('redis.host'),
      port: config.getOrThrow<number>('redis.port'),
      password: config.get<string>('redis.password'),
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      maxRetriesPerRequest: 0,
    });
  }

  @Get('live')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ operationId: 'getLiveness' })
  @apiRawJsonResponse(200, livenessSchema)
  live() {
    return { status: 'ok', version: this.config.getOrThrow<string>('app.version') };
  }

  @Get('ready')
  @Version(VERSION_NEUTRAL)
  @ApiOperation({ operationId: 'getReadiness' })
  @apiRawJsonResponse(200, readinessSchema)
  async ready() {
    const checks: Record<string, 'up' | 'down' | 'degraded' | 'current'> = {
      postgres: 'down',
      redis: 'down',
      migrations: 'down',
      minio: 'down',
      geoService: this.config.get<string>('geoService.baseUrl') ? 'up' : 'degraded',
    };

    await this.dataSource.query('SELECT 1');
    checks.postgres = 'up';
    const pending = await this.dataSource.showMigrations();
    if (pending) throw new Error('Database migrations are pending');
    checks.migrations = 'current';

    if (this.redis.status === 'wait') await this.redis.connect();
    await this.redis.ping();
    checks.redis = 'up';
    await this.storage.ping();
    checks.minio = 'up';

    return {
      status: 'ok',
      version: this.config.getOrThrow<string>('app.version'),
      checks,
    };
  }
}
