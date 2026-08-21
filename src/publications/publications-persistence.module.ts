import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublicationActivationService } from './publication-activation.service';
import {
  PublicationJobBatchEntity,
  PublicationJobEntity,
  PublicationJobOutboxEntity,
  PublicationWorkerStateEntity,
} from './publication.entities';
import { PublicationFingerprintService } from './publication-fingerprint.service';
import { PublicationJobRepository } from './publication-job.repository';
import { PublicationWorkerRepository } from './publication-worker.repository';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PublicationJobEntity,
      PublicationJobBatchEntity,
      PublicationJobOutboxEntity,
      PublicationWorkerStateEntity,
    ]),
  ],
  providers: [
    PublicationJobRepository,
    PublicationWorkerRepository,
    PublicationFingerprintService,
    PublicationActivationService,
  ],
  exports: [
    PublicationJobRepository,
    PublicationWorkerRepository,
    PublicationFingerprintService,
    PublicationActivationService,
  ],
})
export class PublicationsPersistenceModule {}
