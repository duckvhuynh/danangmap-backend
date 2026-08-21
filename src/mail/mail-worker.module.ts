import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailOutboxEntity } from '../identity/identity.entities';
import { MailDeliveryService } from './mail-delivery.service';
import { MailProcessor } from './mail.processor';
import { MailScheduler } from './mail.scheduler';
import { MailTemplateService } from './mail-template.service';
import { SmtpMailerService } from './smtp-mailer.service';

@Module({
  imports: [TypeOrmModule.forFeature([MailOutboxEntity])],
  providers: [
    MailTemplateService,
    SmtpMailerService,
    MailDeliveryService,
    MailProcessor,
    MailScheduler,
  ],
})
export class MailWorkerModule {}
