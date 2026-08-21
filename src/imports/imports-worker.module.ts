import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeometryService } from '../layers/geometry.service';
import { LayerSchemaService } from '../layers/layer-schema.service';
import { ImportProcessor } from './import.processor';
import { ImportJobEntity } from './import.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ImportJobEntity])],
  providers: [GeometryService, LayerSchemaService, ImportProcessor],
})
export class ImportsWorkerModule {}
