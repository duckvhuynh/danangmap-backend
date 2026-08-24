import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { AttachmentEntity, FeatureVersionAttachmentEntity } from './attachment.entities';
import { AdminAttachmentsController, PublicAttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  imports: [
    IdentityModule,
    TypeOrmModule.forFeature([AttachmentEntity, FeatureVersionAttachmentEntity]),
  ],
  controllers: [AdminAttachmentsController, PublicAttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
