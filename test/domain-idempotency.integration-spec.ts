import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { AuditService } from '../src/audit/audit.service';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { AppException } from '../src/common/http/app.exception';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import AppDataSource from '../src/database/data-source';
import { GeometryService } from '../src/layers/geometry.service';
import { LayerSchemaService } from '../src/layers/layer-schema.service';
import {
  LayerEntity,
  LayerFieldEntity,
  LayerGroupEntity,
  LayerRevisionEntity,
} from '../src/layers/layer.entities';
import { LayersService } from '../src/layers/layers.service';
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
  const submitKey = randomUUID();
  const approveKey = randomUUID();
  const publishKey = randomUUID();
  const rollbackKey = randomUUID();
  const changesSubmitKey = randomUUID();
  const requestChangesKey = randomUUID();
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
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      const layerIds = [featureLayerId, workflowLayerId, changesLayerId, createdLayerId].filter(
        (id): id is string => Boolean(id),
      );
      const revisionIds = [
        featureRevisionId,
        workflowRevisionId,
        changesRevisionId,
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
          ],
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
              OR metadata->>'revisionId'=ANY($2::text[])`,
          [layerIds.concat(revisionIds), revisionIds],
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

    const published = publications[0] as { snapshotId: string };
    const rollbacks = await Promise.all([
      workflow.rollback(
        workflowLayerId,
        { targetSnapshotId: published.snapshotId, reason: 'Receipt rollback' },
        publisher,
        randomUUID(),
        rollbackKey,
      ),
      workflow.rollback(
        workflowLayerId,
        { targetSnapshotId: published.snapshotId, reason: 'Receipt rollback' },
        publisher,
        randomUUID(),
        rollbackKey,
      ),
    ]);
    expect(rollbacks[1]).toEqual(rollbacks[0]);
    await expect(
      createWorkflowService().rollback(
        workflowLayerId,
        { targetSnapshotId: published.snapshotId, reason: 'Receipt rollback' },
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
      snapshots: 2,
      pointers: 1,
      generations: [1, 2],
      activeSnapshotId: rollbacks[0].snapshotId,
      activeGeneration: rollbacks[0].generation,
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
      {} as AuditService,
      new IdempotencyService(),
    );
  }

  function createWorkflowService() {
    return new WorkflowService(AppDataSource, crypto, new IdempotencyService());
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
