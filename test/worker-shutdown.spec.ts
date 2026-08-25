import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { PUBLICATION_BUILD_JOB } from '../src/jobs/jobs.constants';
import type { PublicationActivationService } from '../src/publications/publication-activation.service';
import type { PublicationBuilderService } from '../src/publications/publication-builder.service';
import { PublicationProcessor } from '../src/publications/publication.processor';
import type { PublicationWorkerRepository } from '../src/publications/publication-worker.repository';

describe('worker graceful shutdown', () => {
  it('rejects a new publication delivery after shutdown begins', async () => {
    const claim = jest.fn();
    const processor = new PublicationProcessor(
      { claim } as unknown as PublicationWorkerRepository,
      {} as PublicationBuilderService,
      {} as PublicationActivationService,
      {} as ConfigService,
    );
    const job = {
      name: PUBLICATION_BUILD_JOB,
      data: {
        publicationJobId: '965dc245-dc7b-4b61-9e6d-77d43045bf7e',
        payloadVersion: 1,
      },
    } as Job<{ publicationJobId: string; payloadVersion: number }>;

    processor.onApplicationShutdown();

    await expect(processor.process(job)).rejects.toThrow('PUBLICATION_WORKER_DRAINING');
    expect(claim).not.toHaveBeenCalled();
  });
});
