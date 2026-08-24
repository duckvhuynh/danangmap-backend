import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { AttachmentProcessor } from '../src/attachments/attachment.processor';
import { AttachmentScannerService } from '../src/attachments/attachment-scanner.service';
import { readAttachmentStream } from '../src/attachments/attachment-stream';
import { AttachmentsService } from '../src/attachments/attachments.service';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { AppException } from '../src/common/http/app.exception';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import { ATTACHMENT_QUEUE, ATTACHMENT_SCAN_JOB } from '../src/jobs/jobs.constants';
import { StorageService } from '../src/storage/storage.service';

const editor = { id: '00000000-0000-4000-8000-000000000002', role: 'editor' };

describe('Attachment lifecycle with Postgres, Redis and MinIO', () => {
  const startedAt = new Date();
  const suffix = randomUUID();
  const groupId = randomUUID();
  const layerId = randomUUID();
  const revisionId = randomUUID();
  const featureId = randomUUID();
  const versionId = randomUUID();
  const objectKeys = new Set<string>();
  let queue: Queue;
  let storage: StorageService;
  let attachments: AttachmentsService;
  let processor: AttachmentProcessor;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    const config = new ConfigService({
      FIELD_ENCRYPTION_KEY: 'attachment-test-field-encryption-key',
      SESSION_PEPPER: 'attachment-test-session-pepper-32-characters',
      minio: {
        endpoint: process.env.MINIO_ENDPOINT ?? 'localhost',
        port: Number(process.env.MINIO_PORT ?? 9000),
        useSsl: false,
        publicEndpoint: process.env.MINIO_PUBLIC_ENDPOINT ?? 'localhost',
        publicPort: Number(process.env.MINIO_PUBLIC_PORT ?? 9000),
        publicUseSsl: false,
        publicPathStyle: true,
        region: process.env.MINIO_REGION ?? 'us-east-1',
        accessKey: process.env.MINIO_ACCESS_KEY ?? 'danangmap',
        secretKey: process.env.MINIO_SECRET_KEY ?? 'danangmap-local-secret',
        bucket: process.env.MINIO_BUCKET ?? 'danangmap',
      },
      attachments: {
        uploadTtlSeconds: 600,
        orphanRetentionHours: 24,
        sweepIntervalMs: 60_000,
        scannerMode: 'deterministic',
        clamavHost: 'localhost',
        clamavPort: 3310,
        scanTimeoutMs: 5_000,
      },
    });
    storage = new StorageService(config);
    await storage.onModuleInit();
    queue = new Queue(ATTACHMENT_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: null,
      },
      prefix: `danangmap:test:${suffix}`,
    });
    attachments = new AttachmentsService(
      AppDataSource,
      storage,
      config,
      new CryptoService(config),
      new IdempotencyService(),
      queue,
    );
    processor = new AttachmentProcessor(
      AppDataSource,
      storage,
      new AttachmentScannerService(config),
      queue,
      config,
    );
    await createFixture();
  });

  afterAll(async () => {
    for (const key of objectKeys) await storage.removeIfPresent(key).catch(() => undefined);
    if (AppDataSource.isInitialized) {
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
        await manager.query(
          `DELETE FROM audit_logs WHERE id IN (
             SELECT audit_id FROM audit_layer_scopes WHERE layer_id=$1
           ) OR resource_id=$2`,
          [layerId, featureId],
        );
        await manager.query('DELETE FROM layer_publications WHERE layer_id=$1', [layerId]);
        await manager.query('DELETE FROM publication_snapshots WHERE layer_id=$1', [layerId]);
        await manager.query(
          `DELETE FROM command_receipts
           WHERE actor_id=$1 AND operation LIKE 'attachment.%' AND created_at>=$2`,
          [editor.id, startedAt],
        );
        await manager.query('DELETE FROM revision_changes WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM revision_participants WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM revision_features WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM feature_versions WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM features WHERE layer_id=$1', [layerId]);
        await manager.query('DELETE FROM layer_fields WHERE revision_id=$1', [revisionId]);
        await manager.query('DELETE FROM layer_revisions WHERE id=$1', [revisionId]);
        await manager.query('DELETE FROM layers WHERE id=$1', [layerId]);
        await manager.query('DELETE FROM layer_groups WHERE id=$1', [groupId]);
        await manager.query(
          `DELETE FROM attachments attachment WHERE NOT EXISTS (
             SELECT 1 FROM feature_version_attachments link WHERE link.attachment_id=attachment.id
           ) AND owner_id=$1`,
          [editor.id],
        );
        await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
      });
      await AppDataSource.destroy();
    }
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it('rejects oversized, unfinalized, MIME-spoofed and infected objects', async () => {
    await expect(
      attachments.createUpload(
        {
          purpose: 'feature_attachment',
          fileName: 'too-large.pdf',
          contentType: 'application/pdf',
          sizeBytes: 25 * 1024 * 1024 + 1,
          sha256: 'a'.repeat(64),
        },
        editor,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });

    const incomplete = await attachments.createUpload(
      uploadDto('incomplete.pdf', 'application/pdf', Buffer.from('%PDF-incomplete')),
      editor,
    );
    await expect(attachments.complete(incomplete.uploadId, editor)).rejects.toMatchObject({
      code: 'ATTACHMENT_UPLOAD_INCOMPLETE',
    });
    await expect(
      attachments.bind(
        revisionId,
        featureId,
        { fieldKey: 'images', attachmentId: incomplete.attachmentId, displayOrder: 0 },
        revisionEtag(1),
        randomUUID(),
        editor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_READY' });

    const spoof = Buffer.from('%PDF-1.7 spoof');
    const spoofIntent = await attachments.createUpload(
      uploadDto('spoof.png', 'image/png', spoof),
      editor,
    );
    await putIntent(spoofIntent.attachmentId, spoof, 'image/png');
    await expect(attachments.complete(spoofIntent.uploadId, editor)).rejects.toMatchObject({
      code: 'ATTACHMENT_MIME_MISMATCH',
    });
    await expect(attachments.get(spoofIntent.attachmentId)).resolves.toMatchObject({
      status: 'rejected',
    });

    const infected = Buffer.from(
      '%PDF-1.7\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE',
    );
    const infectedAttachment = await uploadAndScan('infected.pdf', 'application/pdf', infected);
    expect(infectedAttachment).toMatchObject({
      status: 'infected',
      rejectionCode: 'ATTACHMENT_MALWARE_DETECTED',
    });
  });

  it('keeps bindings versioned and only delivers clean public-field objects', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const pdf = Buffer.from('%PDF-1.7 private document');
    const publicAttachment = await uploadAndScan('public.png', 'image/png', png);
    const privateAttachment = await uploadAndScan('private.pdf', 'application/pdf', pdf);
    expect(publicAttachment.status).toBe('clean');
    expect(privateAttachment.status).toBe('clean');

    const firstBind = (await attachments.bind(
      revisionId,
      featureId,
      { fieldKey: 'images', attachmentId: publicAttachment.id, displayOrder: 20 },
      revisionEtag(1),
      randomUUID(),
      editor,
      randomUUID(),
    )) as { etag: string; feature: { meta: { versionId: string } } };
    const firstBoundVersion = firstBind.feature.meta.versionId;
    const privateBind = (await attachments.bind(
      revisionId,
      featureId,
      { fieldKey: 'documents', attachmentId: privateAttachment.id, displayOrder: 10 },
      firstBind.etag,
      randomUUID(),
      editor,
      randomUUID(),
    )) as { etag: string };
    const reordered = (await attachments.reorder(
      revisionId,
      featureId,
      'images',
      [publicAttachment.id],
      privateBind.etag,
      randomUUID(),
      editor,
      randomUUID(),
    )) as { etag: string };
    const unbound = (await attachments.unbind(
      revisionId,
      featureId,
      publicAttachment.id,
      reordered.etag,
      randomUUID(),
      editor,
      randomUUID(),
    )) as { etag: string };
    expect(
      Number(
        (
          (await AppDataSource.query(
            `SELECT count(*)::integer AS count FROM feature_version_attachments
             WHERE feature_version_id=$1 AND attachment_id=$2`,
            [firstBoundVersion, publicAttachment.id],
          )) as Array<{ count: number }>
        )[0]?.count,
      ),
    ).toBe(1);
    const rebound = (await attachments.bind(
      revisionId,
      featureId,
      { fieldKey: 'images', attachmentId: publicAttachment.id, displayOrder: 0 },
      unbound.etag,
      randomUUID(),
      editor,
      randomUUID(),
    )) as {
      etag: string;
      feature: { meta: { versionId: string }; properties: Record<string, unknown> };
    };
    expect(rebound.feature.properties).toMatchObject({
      images: [publicAttachment.id],
      documents: [privateAttachment.id],
    });

    await expect(attachments.publicObject(publicAttachment.id)).rejects.toBeInstanceOf(
      AppException,
    );
    await publishFixture();
    const publicObject = await attachments.publicObject(publicAttachment.id);
    objectKeys.add(publicObject.objectKey);
    await expect(readAttachmentStream(publicObject.stream)).resolves.toEqual(png);
    await expect(attachments.publicObject(privateAttachment.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const links = await attachments.publicLinksForVersion(
      rebound.feature.meta.versionId,
      revisionId,
    );
    expect(links.map((link) => link.id)).toEqual([publicAttachment.id]);
  });

  async function createFixture(): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO layer_groups(id,slug,title,display_order) VALUES($1,$2,'Attachments',1)`,
        [groupId, `attachments-${suffix}`],
      );
      await manager.query(
        `INSERT INTO layers(id,slug,group_id,display_order,created_by)
         VALUES($1,$2,$3,1,$4)`,
        [layerId, `attachments-${suffix}`, groupId, editor.id],
      );
      await manager.query(
        `INSERT INTO layer_revisions(
           id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,
           style,render_config,popup_config,schema_version,lock_version,cursor_seq,created_by
         ) VALUES($1,$2,1,'draft','Attachments','point','{point}'::text[],
           '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,1,1,0,$3)`,
        [revisionId, layerId, editor.id],
      );
      await manager.query(
        `INSERT INTO layer_fields(
           revision_id,key,label,type,required,public,sensitive,offline_cache,validation,options,display_order
         ) VALUES
           ($1,'name','Name','text',true,true,false,true,'{}','[]',0),
           ($1,'images','Images','image',false,true,false,true,'{}','[]',10),
           ($1,'documents','Documents','attachment',false,false,false,true,'{}','[]',20)`,
        [revisionId],
      );
      await manager.query(`INSERT INTO features(id,layer_id) VALUES($1,$2)`, [featureId, layerId]);
      await manager.query(
        `INSERT INTO feature_versions(
           id,feature_id,revision_id,geometry,geometry_kind,properties,checksum,created_by
         ) VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint(108.2,16.05),4326),'point',
           '{"name":"Attachment fixture","images":[],"documents":[]}'::jsonb,'initial',$4)`,
        [versionId, featureId, revisionId, editor.id],
      );
      await manager.query(
        `INSERT INTO revision_features(revision_id,feature_id,feature_version_id)
         VALUES($1,$2,$3)`,
        [revisionId, featureId, versionId],
      );
    });
  }

  async function uploadAndScan(fileName: string, contentType: string, content: Buffer) {
    const intent = await attachments.createUpload(
      uploadDto(fileName, contentType, content),
      editor,
    );
    await putIntent(intent.attachmentId, content, contentType);
    await attachments.complete(intent.uploadId, editor);
    await processor.process({
      name: ATTACHMENT_SCAN_JOB,
      data: { attachmentId: intent.attachmentId },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as Job<{ attachmentId: string }>);
    const row = await attachments.get(intent.attachmentId);
    const keys = (await AppDataSource.query(
      `SELECT quarantine_key AS "quarantineKey",object_key AS "objectKey"
       FROM attachments WHERE id=$1`,
      [intent.attachmentId],
    )) as Array<{ quarantineKey: string; objectKey: string | null }>;
    objectKeys.add(keys[0]!.quarantineKey);
    if (keys[0]!.objectKey) objectKeys.add(keys[0]!.objectKey);
    return row;
  }

  async function putIntent(attachmentId: string, content: Buffer, contentType: string) {
    const rows = (await AppDataSource.query(
      `SELECT quarantine_key AS "quarantineKey" FROM attachments WHERE id=$1`,
      [attachmentId],
    )) as Array<{ quarantineKey: string }>;
    objectKeys.add(rows[0]!.quarantineKey);
    await storage.putBuffer(rows[0]!.quarantineKey, content, contentType);
  }

  function uploadDto(fileName: string, contentType: string, content: Buffer) {
    return {
      purpose: 'feature_attachment' as const,
      fileName,
      contentType,
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  function revisionEtag(version: number): string {
    return `"rev-${revisionId}-v${version}"`;
  }

  async function publishFixture(): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE layer_revisions SET status='published',published_at=now() WHERE id=$1`,
        [revisionId],
      );
      const snapshot = (await manager.query(
        `INSERT INTO publication_snapshots(
           layer_id,revision_id,status,generation,feature_count,checksum,manifest,published_by,
           published_at,activated_at
         ) VALUES($1,$2,'published',1,1,'attachment-test','{"attachmentProjection":"versioned"}',
           $3,now(),now()) RETURNING id`,
        [layerId, revisionId, editor.id],
      )) as Array<{ id: string }>;
      await manager.query(
        `INSERT INTO layer_publications(layer_id,active_snapshot_id,pointer_updated_at)
         VALUES($1,$2,now())`,
        [layerId, snapshot[0]!.id],
      );
    });
  }
});
