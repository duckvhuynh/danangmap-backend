import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { UserImportIssueEntity, UserImportJobEntity } from './user-import.entity';
import { UserImportUploadGuard } from './user-import-upload.guard';
import { UserImportsController } from './user-imports.controller';
import { UserImportsService } from './user-imports.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserImportJobEntity, UserImportIssueEntity]), IdentityModule],
  controllers: [UserImportsController],
  providers: [UserImportsService, UserImportUploadGuard],
})
export class UserImportsModule {}
