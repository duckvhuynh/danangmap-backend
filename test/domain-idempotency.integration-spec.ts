import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { AppException } from '../src/common/http/app.exception';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import { GeometryService } from '../src/layers/geometry.service';
import { ChangeFeedRetentionService } from '../src/layers/change-feed-retention.service';
import { LayerSchemaService } from '../src/layers/layer-schema.service';
import {
  LayerEntity,
  LayerFieldEntity,
  LayerGroupEntity,
  LayerRevisionEntity,
} from '../src/layers/layer.entities';
import { LayersService } from '../src/layers/layers.service';
import { publicationPointerEtag } from '../src/layers/etag';
import { PublicationRollbackService } from '../src/history/publication-rollback.service';
import { PublicationAdmissionService } from '../src/publications/publication-admission.service';
import { PublicationFingerprintService } from '../src/publications/publication-fingerprint.service';
import { PublicationJobRepository } from '../src/publications/publication-job.repository';
import { WorkflowService } from '../src/workflow/workflow.service';

describe('Domain command idempotency', () => {
  const editorId = '00000000-0000-4000-8000-000000000002';
  const reviewerId = '00000000-0000-4000-8000-000000000003';
  const publisherId = '00000000-0000-4000-8000-000000000004';
  const featureLayerId = randomUUID();
  const featureRevisionId = randomUUID();
  const featureKey = randomUUID();
  const createLayerKey = randomUUID();
  const workflowLayerId = randomUUID();
  const workflowRevisionId = randomUUID();
  const changesLayerId = randomUUID();
  const changesRevisionId = randomUUID();
  const crossSyncLayerId = randomUUID();
  const crossSyncRevisionId = randomUUID();
  const crossAsyncLayerId = randomUUID();
  const crossAsyncRevisionId = randomUUID();
  const submitKey = randomUUID();
  const approveKey = randomUUID();
  const publishKey = randomUUID();
  const rollbackKey = randomUUID();
  const changesSubmitKey = randomUUID();
  const requestChangesKey = randomUUID();
  const crossSyncKey = randomUUID();
  const crossAsyncKey = randomUUID();
  let createdLayerId: string | undefined;
  let createdRevisionId: string | undefined;
  const crypto = new CryptoService(
    new ConfigService({
      FIELD_ENCRYPTION_KEY: 'integration-field-key',
      SESSION_PEPPER: 'integration-session-pepper',
    }),
  );

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await createDraft(featureLayerId, featureRevisionId, 'receipt-feature');
    await createDraft(workflowLayerId, workflowRevisionId, 'receipt-workflow');
    await createDraft(changesLayerId, changesRevisionId, 'receipt-changes');
    await createApproved(crossSyncLayerId, crossSyncRevisionId, 'receipt-cross-sync');
    await createApproved(crossAsyncLayerId, crossAsyncRevisionId, 'receipt-cross-async');
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      const layerIds = [
        featureLayerId,
        workflowLayerId,
        changesLayerId,
        crossSyncLayerId,
        crossAsyncLayerId,
        createdLayerId,
      ].filter((id): id is string => Boolean(id));
      const revisionIds = [
        featureRevisionId,
        workflowRevisionId,
        changesRevisionId,
        crossSyncRevisionId,
        crossAsyncRevisionId,
        createdRevisionId,
      ].filter((id): id is string => Boolean(id));
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
        await manager.query(
          'ALTER TABLE workflow_events DISABLE TRIGGER trg_workflow_events_immutable',
        );
        await manager.query(`DELETE FROM command_receipts WHERE idempotency_key=ANY($1::uuid[])`, [
          [
            featureKey,
            createLayerKey,
            submitKey,
            approveKey,
            publishKey,
            rollbackKey,
            changesSubmitKey,
            requestChangesKey,
            crossSyncKey,
            crossAsyncKey,
          ],
        ]);
        await manager.query('DELETE FROM publication_jobs WHERE layer_id=ANY($1::uuid[])', [
          layerIds,
        ]);
        await manager.query('DELETE FROM layer_publications WHERE layer_id=ANY($1::uuid[])', [
          layerIds,
        ]);
        await manager.query('DELETE FROM publication_snapshots WHERE layer_id=ANY($1::uuid[])', [
          layerIds,
        ]);
        await manager.query(
          'DELETE FROM workflow_events WHERE revision_id IN (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))',
          [layerIds],
        );
        await manager.query(
          'DELETE FROM revision_changes WHERE revision_id IN (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))',
          [layerIds],
        );
        await manager.query(
          'DELETE FROM revision_features WHERE revision_id IN (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))',
          [layerIds],
        );
        await manager.query(
          'DELETE FROM feature_versions WHERE revision_id IN (SELECT id FROM layer_revisions WHERE layer_id=ANY($1::uuid[]))',
          [layerIds],
        );
        await manager.query('DELETE FROM features WHERE layer_id=ANY($1::uuid[])', [layerIds]);
        await manager.query(
          `DELETE FROM audit_logs
           WHERE resource_id=ANY($1::uuid[])
              OR metadata->>'revisionId'=ANY($2::text[])
              OR metadata->>'layerId'=ANY($3::text[])`,
          [layerIds.concat(revisionIds), revisionIds, layerIds],
        );
        await manager.query('DELETE FROM layer_revisions WHERE layer_id=ANY($1::uuid[])', [
          layerIds,
        ]);
        await manager.query('DELETE FROM layers WHERE id=ANY($1::uuid[])', [layerIds]);
        await manager.query('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
        await manager.query(
          'ALTER TABLE workflow_events ENABLE TRIGGER trg_workflow_events_immutable',
        );
      });
      await AppDataSource.destroy();
    }
  });

  it('deduplicates concurrent createLayer and restores its original ETag', async () => {
    const service = createLayersService();
    const dto = {
      slug: `receipt-layer-${createLayerKey.slice(0, 8)}`,
      displayOrder: 1,
      defaultVisible: true,
      title: 'Receipt layer',
      geometryMode: 'point' as const,
      allowedGeometryKinds: ['point' as const],
      fields: [
        {
          key: 'name',
          label: 'Tên',
          type: 'text',
          required: true,
          public: true,
          searchable: true,
          filterable: false,
          sortable: true,
          sensitive: false,
          offlineCache: true,
          validation: {},
          options: [],
          displayOrder: 1,
        },
      ],
      style: {},
      renderConfig: {},
      popupConfig: { titleField: 'name' },
    };
    const actor = { id: editorId, role: 'editor' };
    const results = await Promise.all([
      service.createLayer(dto, actor, randomUUID(), createLayerKey),
      service.createLayer(dto, actor, randomUUID(), createLayerKey),
    ]);
    expect(jsonBody(results[1])).toEqual(jsonBody(results[0]));
    expect(results[0].etag).toBe(`"rev-${results[0].draftRevision.id}-v1"`);
    createdLayerId = results[0].layer.id;
    createdRevisionId = results[0].draftRevision.id;
    await expect(
      createLayersService().createLayer(dto, actor, randomUUID(), createLayerKey),
    ).resolves.toEqual(jsonBody(results[0]));
    const rows = (await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM layers WHERE slug=$1`,
      [dto.slug],
    )) as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(1);
    await expectAppCode(
      createLayersService().createLayer(
        { ...dto, title: 'Changed payload' },
        actor,
        randomUUID(),
        createLayerKey,
      ),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('replays createFeature after the revision leaves draft without a duplicate delta', async () => {
    const service = createLayersService();
    const dto = {
      geometry: { type: 'Point', coordinates: [108.2, 16.1] },
      geometryKind: 'point' as const,
      properties: { name: 'Receipt fixture' },
    };
    const actor = { id: editorId, role: 'editor' };
    const etag = `"rev-${featureRevisionId}-v1"`;
    const first = await service.createFeature(
      featureRevisionId,
      dto,
      etag,
      actor,
      randomUUID(),
      featureKey,
    );
    expect(first.etag).toBe(`"rev-${featureRevisionId}-v2"`);
    await AppDataSource.query(
      `UPDATE layer_revisions SET status='in_review',lock_version=lock_version+1 WHERE id=$1`,
      [featureRevisionId],
    );

    const restartedService = createLayersService();
    const replay = await restartedService.createFeature(
      featureRevisionId,
      dto,
      etag,
      actor,
      randomUUID(),
      featureKey,
    );
    expect(jsonBody(replay)).toEqual(jsonBody(first));
    const counts = (await AppDataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM revision_features WHERE revision_id=$1) AS features,
         (SELECT count(*)::integer FROM revision_changes WHERE revision_id=$1) AS changes`,
      [featureRevisionId],
    )) as Array<{ features: number; changes: number }>;
    expect(counts[0]).toEqual({ features: 1, changes: 1 });

    await expectAppCode(
      restartedService.createFeature(
        featureRevisionId,
        { ...dto, properties: { name: 'Changed payload' } },
        etag,
        actor,
        randomUUID(),
        featureKey,
      ),
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('deduplicates concurrent submit, approve and publish into one immutable publication', async () => {
    const editor = { id: editorId, role: 'editor' };
    const reviewer = { id: reviewerId, role: 'reviewer' };
    const publisher = { id: publisherId, role: 'publisher' };
    const workflow = createWorkflowService();

    const submits = await Promise.all([
      workflow.submit(workflowRevisionId, { summary: 'Ready' }, editor, randomUUID(), submitKey),
      workflow.submit(workflowRevisionId, { summary: 'Ready' }, editor, randomUUID(), submitKey),
    ]);
    expect(submits[1]).toEqual(submits[0]);
    await expect(
      createWorkflowService().submit(
        workflowRevisionId,
        { summary: 'Ready' },
        editor,
        randomUUID(),
        submitKey,
      ),
    ).resolves.toEqual(submits[0]);

    const approvals = await Promise.all([
      workflow.approve(workflowRevisionId, {}, reviewer, randomUUID(), approveKey),
      workflow.approve(workflowRevisionId, {}, reviewer, randomUUID(), approveKey),
    ]);
    expect(approvals[1]).toEqual(approvals[0]);

    const publications = await Promise.all([
      workflow.publish(
        workflowRevisionId,
        { releaseNote: 'Release' },
        publisher,
        randomUUID(),
        publishKey,
      ),
      workflow.publish(
        workflowRevisionId,
        { releaseNote: 'Release' },
        publisher,
        randomUUID(),
        publishKey,
      ),
    ]);
    expect(publications[1]).toEqual(publications[0]);
    await expect(
      createWorkflowService().publish(
        workflowRevisionId,
        { releaseNote: 'Release' },
        publisher,
        randomUUID(),
        publishKey,
      ),
    ).resolves.toEqual(publications[0]);
    await expectAppCode(
      createWorkflowService().publish(
        workflowRevisionId,
        { releaseNote: 'Different' },
        publisher,
        randomUUID(),
        publishKey,
      ),
      'IDEMPOTENCY_KEY_REUSED',
    );

    const published = publications[0].data as { snapshotId: string };
    const replacementRows = (await AppDataSource.query(
      `INSERT INTO publication_snapshots(
         layer_id,revision_id,status,generation,feature_count,bounds,checksum,manifest,published_by,published_at
       )
       SELECT layer_id,revision_id,status,generation+1,feature_count,bounds,checksum,manifest,published_by,now()
       FROM publication_snapshots WHERE id=$1 RETURNING id`,
      [published.snapshotId],
    )) as Array<{ id: string }>;
    await AppDataSource.query(
      `UPDATE layer_publications
       SET previous_snapshot_id=active_snapshot_id,active_snapshot_id=$2,pointer_updated_at=now()
       WHERE layer_id=$1`,
      [workflowLayerId, replacementRows[0]!.id],
    );
    const rollback = createRollbackService();
    const rollbackDto = {
      targetSnapshotId: published.snapshotId,
      reason: 'Receipt rollback',
      clientIntent: 'desktop' as const,
    };
    const rollbackEtag = publicationPointerEtag(workflowLayerId, replacementRows[0]!.id, 2);
    const rollbacks = await Promise.all([
      rollback.rollback(
        workflowLayerId,
        rollbackDto,
        rollbackEtag,
        publisher,
        randomUUID(),
        rollbackKey,
      ),
      rollback.rollback(
        workflowLayerId,
        rollbackDto,
        rollbackEtag,
        publisher,
        randomUUID(),
        rollbackKey,
      ),
    ]);
    expect(rollbacks[1]).toEqual(rollbacks[0]);
    await expect(
      createRollbackService().rollback(
        workflowLayerId,
        rollbackDto,
        rollbackEtag,
        publisher,
        randomUUID(),
        rollbackKey,
      ),
    ).resolves.toEqual(rollbacks[0]);

    const rows = (await AppDataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM workflow_events WHERE revision_id=$1) AS events,
         (SELECT count(*)::integer FROM publication_snapshots WHERE layer_id=$2) AS snapshots,
         (SELECT count(*)::integer FROM layer_publications WHERE layer_id=$2) AS pointers,
         ARRAY(SELECT generation::integer FROM publication_snapshots WHERE layer_id=$2 ORDER BY generation) AS generations,
         (SELECT active_snapshot_id FROM layer_publications WHERE layer_id=$2) AS "activeSnapshotId",
         (SELECT ps.generation::integer
            FROM layer_publications lp
            JOIN publication_snapshots ps ON ps.id=lp.active_snapshot_id
           WHERE lp.layer_id=$2) AS "activeGeneration"`,
      [workflowRevisionId, workflowLayerId],
    )) as Array<{
      events: number;
      snapshots: number;
      pointers: number;
      generations: number[];
      activeSnapshotId: string;
      activeGeneration: number;
    }>;
    expect(rows[0]).toEqual({
      events: 3,
      snapshots: 3,
      pointers: 1,
      generations: [1, 2, 3],
      activeSnapshotId: rollbacks[0].data.snapshotId,
      activeGeneration: rollbacks[0].data.generation,
    });
  });

  it('deduplicates request-changes into one successor draft', async () => {
    const editor = { id: editorId, role: 'editor' };
    const reviewer = { id: reviewerId, role: 'reviewer' };
    const workflow = createWorkflowService();
    await workflow.submit(
      changesRevisionId,
      { summary: 'Needs reviewer' },
      editor,
      randomUUID(),
      changesSubmitKey,
    );
    const results = await Promise.all([
      workflow.requestChanges(
        changesRevisionId,
        { comment: 'Please revise' },
        reviewer,
        randomUUID(),
        requestChangesKey,
      ),
      workflow.requestChanges(
        changesRevisionId,
        { comment: 'Please revise' },
        reviewer,
        randomUUID(),
        requestChangesKey,
      ),
    ]);
    expect(results[1]).toEqual(results[0]);
    await expect(
      createWorkflowService().requestChanges(
        changesRevisionId,
        { comment: 'Please revise' },
        reviewer,
        randomUUID(),
        requestChangesKey,
      ),
    ).resolves.toEqual(results[0]);
    const rows = (await AppDataSource.query(
      `SELECT count(*)::integer AS successors,
              count(*) FILTER (WHERE status='draft')::integer AS drafts
       FROM layer_revisions WHERE layer_id=$1 AND supersedes_revision_id=$2`,
      [changesLayerId, changesRevisionId],
    )) as Array<{ successors: number; drafts: number }>;
    expect(rows[0]).toEqual({ successors: 1, drafts: 1 });
  });

  it('replays the original publication representation and headers across feature-flag modes', async () => {
    const publisher = { id: publisherId, role: 'publisher' };
    const dto = { releaseNote: 'Cross-mode receipt', clientIntent: 'desktop' as const };

    const synchronous = await createWorkflowService().publish(
      crossSyncRevisionId,
      dto,
      publisher,
      randomUUID(),
      crossSyncKey,
    );
    const synchronousThroughAsync = await createAdmissionService().admit(
      crossSyncRevisionId,
      dto,
      publisher,
      randomUUID(),
      crossSyncKey,
    );
    expect(synchronousThroughAsync).toEqual(synchronous);
    expect(synchronousThroughAsync).toMatchObject({
      variant: 'legacy-sync',
      etag: null,
      location: null,
      retryAfter: null,
      cacheControl: null,
    });
    await AppDataSource.query(
      `UPDATE command_receipts SET response_metadata=NULL
       WHERE actor_id=$1 AND operation='revision.publish' AND idempotency_key=$2`,
      [publisherId, crossSyncKey],
    );
    await expect(
      createAdmissionService().admit(
        crossSyncRevisionId,
        dto,
        publisher,
        randomUUID(),
        crossSyncKey,
      ),
    ).resolves.toEqual(synchronous);
    await AppDataSource.query(
      `UPDATE command_receipts SET response_metadata=$3::jsonb
       WHERE actor_id=$1 AND operation='revision.publish' AND idempotency_key=$2`,
      [publisherId, crossSyncKey, JSON.stringify({ variant: 'legacy-sync' })],
    );

    const asynchronous = await createAdmissionService().admit(
      crossAsyncRevisionId,
      dto,
      publisher,
      randomUUID(),
      crossAsyncKey,
    );
    const asynchronousThroughSync = await createWorkflowService().publish(
      crossAsyncRevisionId,
      dto,
      publisher,
      randomUUID(),
      crossAsyncKey,
    );
    expect(asynchronousThroughSync).toEqual(asynchronous);
    expect(asynchronousThroughSync.variant).toBe('durable-async');
    expect(asynchronousThroughSync.etag).toMatch(/^"publication-job-/);
    expect(asynchronousThroughSync.location).toBe(
      `/api/v1/admin/publication-jobs/${(asynchronous.data as { id: string }).id}`,
    );
    expect(asynchronousThroughSync.retryAfter).toBe(2);
    expect(asynchronousThroughSync.cacheControl).toBe('private, no-store');

    const rows = (await AppDataSource.query(
      `SELECT idempotency_key,response_etag,response_metadata
       FROM command_receipts WHERE idempotency_key=ANY($1::uuid[]) ORDER BY idempotency_key`,
      [[crossSyncKey, crossAsyncKey]],
    )) as Array<{
      idempotency_key: string;
      response_etag: string | null;
      response_metadata: Record<string, unknown>;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.idempotency_key === crossSyncKey)).toMatchObject({
      response_etag: null,
      response_metadata: { variant: 'legacy-sync' },
    });
    const asyncReceipt = rows.find((row) => row.idempotency_key === crossAsyncKey);
    expect(asyncReceipt?.response_etag).toMatch(/^"publication-job-/);
    expect(asyncReceipt?.response_metadata).toEqual({
      variant: 'durable-async',
      retryAfter: 2,
    });
    const effects = (await AppDataSource.query(
      `SELECT
         (SELECT count(*)::integer FROM publication_snapshots WHERE layer_id=$1) AS sync_snapshots,
         (SELECT count(*)::integer FROM publication_jobs WHERE layer_id=$2) AS async_jobs,
         (SELECT count(*)::integer FROM publication_job_outbox outbox
          JOIN publication_jobs job ON job.id=outbox.publication_job_id WHERE job.layer_id=$2) AS outboxes`,
      [crossSyncLayerId, crossAsyncLayerId],
    )) as Array<Record<string, unknown>>;
    expect(effects[0]).toEqual({ sync_snapshots: 1, async_jobs: 1, outboxes: 1 });
  });

  async function createDraft(layerId: string, revisionId: string, prefix: string) {
    await AppDataSource.query(`INSERT INTO layers(id,slug,created_by) VALUES($1,$2,$3)`, [
      layerId,
      `${prefix}-${layerId.slice(0, 8)}`,
      editorId,
    ]);
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
         id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,
         style,render_config,popup_config,created_by
       ) VALUES($1,$2,1,'draft',$3,'point',ARRAY['point'],'{}','{}','{}',$4)`,
      [revisionId, layerId, prefix, editorId],
    );
    await AppDataSource.query(
      `INSERT INTO layer_fields(revision_id,key,label,type,required,display_order)
       VALUES($1,'name','Tên','text',true,1)`,
      [revisionId],
    );
    await AppDataSource.query(
      `INSERT INTO revision_participants(revision_id,user_id,participation_type)
       VALUES($1,$2,'edit')`,
      [revisionId, editorId],
    );
  }

  async function createApproved(layerId: string, revisionId: string, prefix: string) {
    await AppDataSource.query(`INSERT INTO layers(id,slug,created_by) VALUES($1,$2,$3)`, [
      layerId,
      `${prefix}-${layerId.slice(0, 8)}`,
      editorId,
    ]);
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
         id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,
         style,render_config,popup_config,created_by
       ) VALUES($1,$2,1,'approved',$3,'point',ARRAY['point'],'{}','{}','{}',$4)`,
      [revisionId, layerId, prefix, editorId],
    );
  }

  function createLayersService() {
    return new LayersService(
      AppDataSource,
      AppDataSource.getRepository(LayerGroupEntity),
      AppDataSource.getRepository(LayerEntity),
      AppDataSource.getRepository(LayerRevisionEntity),
      AppDataSource.getRepository(LayerFieldEntity),
      new GeometryService(AppDataSource),
      new LayerSchemaService(),
      crypto,
      new IdempotencyService(),
      new ChangeFeedRetentionService(
        new ConfigService({ featureSync: { changeRetention: 10_000 } }),
      ),
    );
  }

  function createWorkflowService() {
    return new WorkflowService(AppDataSource, crypto, new IdempotencyService());
  }

  function createAdmissionService() {
    return new PublicationAdmissionService(
      AppDataSource,
      new PublicationFingerprintService(crypto),
      new IdempotencyService(),
      new PublicationJobRepository(AppDataSource),
      new ConfigService({
        publication: { dispatchIntervalMs: 2_000, maxAttempts: 5 },
      }),
    );
  }

  function createRollbackService() {
    return new PublicationRollbackService(AppDataSource, crypto, new IdempotencyService());
  }

  async function expectAppCode(promise: Promise<unknown>, code: string): Promise<void> {
    try {
      await promise;
      throw new Error(`Expected ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ code });
    }
  }

  function jsonBody<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }
});
