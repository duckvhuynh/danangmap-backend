import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttachmentEntity } from './attachment.entities';
import { AttachmentProcessor, AttachmentScheduler } from './attachment.processor';
import { AttachmentScannerService } from './attachment-scanner.service';

@Module({
  imports: [TypeOrmModule.forFeature([AttachmentEntity])],
  providers: [AttachmentScannerService, AttachmentProcessor, AttachmentScheduler],
})
export class AttachmentsWorkerModule {}
