import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityModule } from '../identity/identity.module';
import { LayersModule } from '../layers/layers.module';
import { PublicationAdmissionService } from './publication-admission.service';
import { PublicationCommandService } from './publication-command.service';
import { PublicationController } from './publication.controller';
import {
  PublicationJobBatchEntity,
  PublicationJobEntity,
  PublicationJobOutboxEntity,
  PublicationWorkerStateEntity,
} from './publication.entities';
import { PublicationJobRepository } from './publication-job.repository';
import { PublicationOutboxService } from './publication-outbox.service';
import { PublicationQueryService } from './publication-query.service';

@Module({
  imports: [
    IdentityModule,
    LayersModule,
    TypeOrmModule.forFeature([
      PublicationJobEntity,
      PublicationJobBatchEntity,
      PublicationJobOutboxEntity,
      PublicationWorkerStateEntity,
    ]),
  ],
  controllers: [PublicationController],
  providers: [
    PublicationJobRepository,
    PublicationQueryService,
    PublicationAdmissionService,
    PublicationCommandService,
    PublicationOutboxService,
  ],
  exports: [PublicationQueryService],
})
export class PublicationsModule {}
