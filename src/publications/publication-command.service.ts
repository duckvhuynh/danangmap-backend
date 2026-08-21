import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublishRevisionDto } from '../layers/layer.dto';
import { WorkflowService } from '../workflow/workflow.service';
import { PublicationAdmissionService } from './publication-admission.service';
import type { PublicationExecutionResult } from './publication-result';

interface Actor {
  id: string;
  role: string;
}

@Injectable()
export class PublicationCommandService {
  constructor(
    private readonly config: ConfigService,
    private readonly admission: PublicationAdmissionService,
    private readonly workflow: WorkflowService,
  ) {}

  async publish(
    revisionId: string,
    dto: PublishRevisionDto,
    actor: Actor,
    requestId: string,
    idempotencyKey: string,
  ): Promise<PublicationExecutionResult> {
    if (this.config.getOrThrow<boolean>('publication.asyncEnabled')) {
      return this.admission.admit(revisionId, dto, actor, requestId, idempotencyKey);
    }
    return this.workflow.publish(revisionId, dto, actor, requestId, idempotencyKey);
  }
}
