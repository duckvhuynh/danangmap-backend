import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import {
  ATTACHMENT_QUEUE,
  ATTACHMENT_SCAN_JOB,
  ATTACHMENT_SWEEP_JOB,
  ATTACHMENT_SWEEP_SCHEDULER,
} from '../jobs/jobs.constants';
import { StorageService } from '../storage/storage.service';
import type { AttachmentEntity } from './attachment.entities';
import { readAttachmentStream } from './attachment-stream';
import { AttachmentScannerService } from './attachment-scanner.service';

interface AttachmentJobData {
  attachmentId?: string;
}

@Processor(ATTACHMENT_QUEUE, { concurrency: 2 })
export class AttachmentProcessor extends WorkerHost {
  private readonly logger = new Logger(AttachmentProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly scanner: AttachmentScannerService,
    @InjectQueue(ATTACHMENT_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<AttachmentJobData>): Promise<void> {
    if (job.name === ATTACHMENT_SWEEP_JOB) return this.sweep();
    if (job.name !== ATTACHMENT_SCAN_JOB || !job.data.attachmentId) return;
    try {
      await this.scan(job.data.attachmentId);
    } catch (error) {
      const maxAttempts = Number(job.opts.attempts ?? 1);
      if (job.attemptsMade + 1 >= maxAttempts) {
        await this.dataSource.query(
          `UPDATE attachments SET status='rejected',rejection_code='ATTACHMENT_SCAN_FAILED',
                  scanned_at=now(),updated_at=now()
           WHERE id=$1 AND status='pending'`,
          [job.data.attachmentId],
        );
      }
      throw error;
    }
  }

  private async scan(attachmentId: string): Promise<void> {
    const rows = (await this.dataSource.query(
      `SELECT * FROM attachments WHERE id=$1 AND status='pending'`,
      [attachmentId],
    )) as AttachmentEntity[];
    const attachment = rows[0] as
      | (AttachmentEntity & {
          quarantine_key: string;
          declared_sha256: string;
          declared_size_bytes: number;
          declared_content_type: string;
        })
      | undefined;
    if (!attachment) return;
    const quarantineKey = attachment.quarantine_key ?? attachment.quarantineKey;
    const expectedSha = attachment.declared_sha256 ?? attachment.declaredSha256;
    const expectedSize = Number(attachment.declared_size_bytes ?? attachment.declaredSizeBytes);
    const contentType = attachment.declared_content_type ?? attachment.declaredContentType;
    const content = await readAttachmentStream(await this.storage.getObject(quarantineKey));
    const digest = createHash('sha256').update(content).digest('hex');
    if (content.byteLength !== expectedSize || digest !== expectedSha) {
      await this.reject(attachmentId, 'ATTACHMENT_OBJECT_CHANGED');
      return;
    }
    const verdict = await this.scanner.scan(content);
    if (verdict.status !== 'clean') {
      await this.reject(
        attachmentId,
        verdict.status === 'infected' ? 'ATTACHMENT_MALWARE_DETECTED' : verdict.code,
        verdict.status === 'infected' ? 'infected' : 'rejected',
      );
      return;
    }

    const objectKey = `attachments/${attachmentId}/${digest}`;
    await this.storage.putBuffer(objectKey, content, contentType);
    const updated = (await this.dataSource.query(
      `UPDATE attachments SET status='clean',object_key=$2,scanned_at=now(),updated_at=now()
       WHERE id=$1 AND status='pending' AND declared_sha256=$3
       RETURNING id`,
      [attachmentId, objectKey, digest],
    )) as Array<{ id: string }>;
    if (!updated.length) {
      await this.storage.removeIfPresent(objectKey);
      return;
    }
    this.logger.log(JSON.stringify({ event: 'attachment.scan_clean', attachmentId }));
  }

  private async reject(
    attachmentId: string,
    code: string,
    status: 'infected' | 'rejected' = 'rejected',
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE attachments SET status=$2,rejection_code=$3,scanned_at=now(),updated_at=now()
       WHERE id=$1 AND status='pending'`,
      [attachmentId, status, code],
    );
    this.logger.warn(JSON.stringify({ event: 'attachment.scan_rejected', attachmentId, code }));
  }

  private async sweep(): Promise<void> {
    const pending = (await this.dataSource.query(
      `SELECT id FROM attachments WHERE status='pending' ORDER BY created_at,id LIMIT 100`,
    )) as Array<{ id: string }>;
    await Promise.all(pending.map(({ id }) => enqueueAttachmentScan(this.queue, id)));

    const quarantine = (await this.dataSource.query(
      `SELECT id,quarantine_key AS "quarantineKey" FROM attachments
       WHERE quarantine_removed_at IS NULL AND upload_expires_at<now()
       ORDER BY upload_expires_at,id LIMIT 100`,
    )) as Array<{ id: string; quarantineKey: string }>;
    for (const item of quarantine) {
      await this.storage.removeIfPresent(item.quarantineKey);
      await this.dataSource.query(
        `UPDATE attachments SET quarantine_removed_at=now(),updated_at=now()
         WHERE id=$1 AND quarantine_removed_at IS NULL`,
        [item.id],
      );
    }

    const retentionHours = this.config.getOrThrow<number>('attachments.orphanRetentionHours');
    const orphans = (await this.dataSource.query(
      `SELECT attachment.id,attachment.quarantine_key AS "quarantineKey",
              attachment.object_key AS "objectKey"
       FROM attachments attachment
       WHERE attachment.status IN ('uploading','clean','infected','rejected','deleted')
         AND attachment.created_at<now()-($1::text || ' hours')::interval
         AND NOT EXISTS (
           SELECT 1 FROM feature_version_attachments link WHERE link.attachment_id=attachment.id
         )
       ORDER BY attachment.created_at,attachment.id LIMIT 100`,
      [retentionHours],
    )) as Array<{ id: string; quarantineKey: string; objectKey: string | null }>;
    for (const item of orphans) {
      await this.storage.removeIfPresent(item.quarantineKey);
      await this.storage.removeIfPresent(item.objectKey);
      await this.dataSource.query(
        `DELETE FROM attachments attachment WHERE attachment.id=$1
         AND NOT EXISTS (
           SELECT 1 FROM feature_version_attachments link WHERE link.attachment_id=attachment.id
         )`,
        [item.id],
      );
    }
  }
}

@Injectable()
export class AttachmentScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(ATTACHMENT_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      ATTACHMENT_SWEEP_SCHEDULER,
      { every: this.config.getOrThrow<number>('attachments.sweepIntervalMs') },
      {
        name: ATTACHMENT_SWEEP_JOB,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 20, attempts: 1 },
      },
    );
  }
}

export async function enqueueAttachmentScan(queue: Queue, attachmentId: string): Promise<void> {
  await queue.add(
    ATTACHMENT_SCAN_JOB,
    { attachmentId },
    {
      jobId: `attachment-scan-${attachmentId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: 50,
    },
  );
}
