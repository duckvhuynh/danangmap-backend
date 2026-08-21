import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { IMPORT_QUEUE, USER_IMPORT_QUEUE } from './jobs.constants';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('redis.host'),
          port: config.getOrThrow<number>('redis.port'),
          password: config.get<string>('redis.password'),
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          connectTimeout: 5_000,
        },
        prefix: 'danangmap:q',
      }),
    }),
    BullModule.registerQueue({ name: IMPORT_QUEUE }, { name: USER_IMPORT_QUEUE }),
  ],
  exports: [BullModule],
})
export class JobsModule {}
