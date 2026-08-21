import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImportProcessor } from './import.processor';
import { ImportJobEntity } from './import.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ImportJobEntity])],
  providers: [ImportProcessor],
})
export class ImportsWorkerModule {}
