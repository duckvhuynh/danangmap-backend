import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { AttachmentEntity, FeatureVersionAttachmentEntity } from './attachment.entities';
import { AdminAttachmentsController, PublicAttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ChangeFeedRetentionService } from '../layers/change-feed-retention.service';

@Module({
  imports: [
    IdentityModule,
    TypeOrmModule.forFeature([AttachmentEntity, FeatureVersionAttachmentEntity]),
  ],
  controllers: [AdminAttachmentsController, PublicAttachmentsController],
  providers: [AttachmentsService, ChangeFeedRetentionService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
