import { Module } from '@nestjs/common';
import { PublicationBuilderService } from './publication-builder.service';
import { PublicationProcessor } from './publication.processor';
import { PublicationRecoveryService } from './publication-recovery.service';
import { PublicationTestHooksService } from './publication-test-hooks.service';
import { PublicationsPersistenceModule } from './publications-persistence.module';

const workerProviders =
  process.env.ASYNC_PUBLICATION_ENABLED === 'true'
    ? [
        PublicationTestHooksService,
        PublicationBuilderService,
        PublicationProcessor,
        PublicationRecoveryService,
      ]
    : [];

@Module({ imports: [PublicationsPersistenceModule], providers: workerProviders })
export class PublicationsWorkerModule {}
