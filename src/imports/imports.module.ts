import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { LayerRevisionEntity } from '../layers/layer.entities';
import { ImportFileInspector } from './import-file.inspector';
import { ImportJobEntity } from './import.entity';
import { ImportUploadGuard } from './import-upload.guard';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [TypeOrmModule.forFeature([ImportJobEntity, LayerRevisionEntity]), IdentityModule],
  controllers: [ImportsController],
  providers: [ImportFileInspector, ImportUploadGuard, ImportsService],
})
export class ImportsModule {}
