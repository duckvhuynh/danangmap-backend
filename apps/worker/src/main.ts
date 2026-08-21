import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from '../../../src/worker.module';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: false,
  });
  application.enableShutdownHooks();
  Logger.log('DanangMap worker started', 'WorkerBootstrap');
}

void bootstrap();
