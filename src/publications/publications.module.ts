import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { LayersModule } from '../layers/layers.module';
import { PublicationAdmissionService } from './publication-admission.service';
import { PublicationCommandService } from './publication-command.service';
import { PublicationController } from './publication.controller';
import { PublicationOutboxService } from './publication-outbox.service';
import { PublicationQueryService } from './publication-query.service';
import { PublicationsPersistenceModule } from './publications-persistence.module';

@Module({
  imports: [IdentityModule, LayersModule, PublicationsPersistenceModule],
  controllers: [PublicationController],
  providers: [
    PublicationQueryService,
    PublicationAdmissionService,
    PublicationCommandService,
    PublicationOutboxService,
  ],
  exports: [PublicationQueryService],
})
export class PublicationsModule {}
