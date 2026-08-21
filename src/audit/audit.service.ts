import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntity } from '../identity/identity.entities';

export interface AuditInput {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string;
  metadata?: Record<string, unknown>;
  beforeDigest?: string | null;
  afterDigest?: string | null;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLogEntity)
    private readonly repository: Repository<AuditLogEntity>,
  ) {}

  async append(input: AuditInput): Promise<void> {
    const event = this.repository.create({
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.requestId,
      metadata: input.metadata ?? {},
      beforeDigest: input.beforeDigest ?? null,
      afterDigest: input.afterDigest ?? null,
    });
    await this.repository.save(event);
  }
}
