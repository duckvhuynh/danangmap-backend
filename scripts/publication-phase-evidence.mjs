import pg from 'pg';

const { Client } = pg;
const allowedStages = new Set([
  'seed',
  'queue',
  'progress',
  'crashed',
  'lease-expired',
  'terminal',
]);
const stage = required('DANANGMAP_PUBLICATION_EVIDENCE_STAGE');
const runNonce = required('DANANGMAP_RUN_NONCE');
const jobId = process.env.DANANGMAP_PUBLICATION_JOB_ID?.trim() || null;
const layerSlug =
  process.env.DANANGMAP_ACTIVATION_LAYER_SLUG?.trim() || 'durable-publication-activation';
if (!allowedStages.has(stage)) throw new Error(`Unsupported publication evidence stage: ${stage}`);
if (!/^[a-z0-9-]{16,128}$/u.test(runNonce)) throw new Error('Invalid DANANGMAP_RUN_NONCE.');
if (stage !== 'seed' && !uuid(jobId))
  throw new Error('DANANGMAP_PUBLICATION_JOB_ID must be a UUID.');

const client = new Client({
  connectionString: required('DATABASE_URL'),
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  query_timeout: 35_000,
  application_name: 'danangmap-publication-phase-evidence',
});
await client.connect();

try {
  const fixture = one(
    await client.query(
      `SELECT layer.id AS "layerId",layer.slug,
              published.id AS "publishedRevisionId",approved.id AS "revisionId",
              approved.status AS "revisionStatus",
              (SELECT count(*)::integer FROM revision_features
               WHERE revision_id=approved.id) AS "expectedFeatureTotal",
              (SELECT count(*)::integer FROM revision_features link
               JOIN feature_versions version ON version.id=link.feature_version_id
               WHERE link.revision_id=approved.id
                 AND version.properties->>'activation_run_nonce'=$2) AS "runNonceFeatureTotal",
              (SELECT count(*)::integer FROM revision_features link
               JOIN feature_versions version ON version.id=link.feature_version_id
               WHERE link.revision_id=published.id
                 AND version.properties ? 'activation_run_nonce') AS "baselineRunNonceTotal",
              (SELECT count(*)::integer FROM layer_fields field
               WHERE field.revision_id=approved.id AND field.key='activation_run_nonce'
                 AND field.public=true AND field.sensitive=false) AS "runNoncePublicFieldTotal",
              (SELECT count(*)::integer FROM revision_participants participant
               WHERE participant.revision_id=approved.id
                 AND participant.user_id='00000000-0000-4000-8000-000000000004'
                 AND participant.participation_type IN ('edit','review')) AS "publisherEditorialTotal"
       FROM layers layer
       JOIN layer_revisions published
         ON published.layer_id=layer.id AND published.status='published'
       JOIN layer_revisions approved
         ON approved.layer_id=layer.id
        AND approved.revision_no=2
        AND approved.supersedes_revision_id=published.id
       WHERE layer.slug=$1`,
      [layerSlug, runNonce],
    ),
    'activation fixture',
  );
  const pointer = one(
    await client.query(
      `SELECT pointer.active_snapshot_id AS "activeSnapshotId",
              pointer.previous_snapshot_id AS "previousSnapshotId",
              snapshot.revision_id AS "activeRevisionId",
              snapshot.generation::integer AS generation,
              snapshot.checksum,
              snapshot.feature_count AS "featureCount"
       FROM layer_publications pointer
       JOIN publication_snapshots snapshot ON snapshot.id=pointer.active_snapshot_id
       WHERE pointer.layer_id=$1`,
      [fixture.layerId],
    ),
    'active publication pointer',
  );
  pointer.activePointerEtag = `"publication-pointer-${fixture.layerId}-${pointer.activeSnapshotId}-g${pointer.generation}"`;
  const counts = one(
    await client.query(
      `SELECT
         (SELECT count(*)::integer FROM publication_snapshots WHERE layer_id=$1) AS snapshots,
         (SELECT count(*)::integer FROM publication_jobs WHERE layer_id=$1) AS jobs,
         (SELECT count(*)::integer FROM publication_job_batches batch
          JOIN publication_jobs job ON job.id=batch.job_id
          WHERE job.layer_id=$1) AS batches,
         (SELECT COALESCE(sum(batch.feature_count),0)::integer FROM publication_job_batches batch
          JOIN publication_jobs job ON job.id=batch.job_id
          WHERE job.layer_id=$1) AS "batchFeatures",
         (SELECT COALESCE(sum(jsonb_array_length(batch.public_projection)),0)::integer
          FROM publication_job_batches batch
          JOIN publication_jobs job ON job.id=batch.job_id
          WHERE job.layer_id=$1) AS "projectionFeatures",
         (SELECT count(*)::integer FROM publication_job_batches batch
          JOIN publication_jobs job ON job.id=batch.job_id
          CROSS JOIN LATERAL jsonb_array_elements(batch.public_projection) projection
          WHERE job.layer_id=$1
            AND projection->'properties'->>'activation_run_nonce'=$3) AS "runNonceProjectionTotal",
         (SELECT count(*)::integer FROM publication_job_batches batch
          JOIN publication_jobs job ON job.id=batch.job_id
          CROSS JOIN LATERAL jsonb_array_elements(batch.public_projection) projection
          WHERE job.layer_id=$1
            AND projection->'properties' ? 'internal_note') AS "privateProjectionTotal",
         (SELECT count(*)::integer FROM revision_participants
          WHERE revision_id=$2 AND participation_type='publish') AS "publishParticipants",
         (SELECT count(*)::integer FROM workflow_events
          WHERE revision_id=$2 AND to_status='published') AS "publishedWorkflowEvents",
         (SELECT count(*)::integer FROM audit_logs
          WHERE resource_id=$2 AND action='revision.published') AS "publishedAudits",
         (SELECT count(*)::integer FROM audit_logs
          WHERE resource_id=$2 AND action='publication.queued') AS "queuedAudits"`,
      [fixture.layerId, fixture.revisionId, runNonce],
    ),
    'activation counts',
  );
  const worker = one(
    await client.query(
      `SELECT recovered_lease_count::integer AS "recoveredLeases",
              completed_job_count::integer AS "completedJobs",
              failed_job_count::integer AS "failedJobs"
       FROM publication_worker_state WHERE id=1`,
    ),
    'publication worker state',
  );
  const job = jobId
    ? one(
        await client.query(
          `SELECT job.id,job.layer_id AS "layerId",job.revision_id AS "revisionId",
                  job.status,job.phase,job.attempts,job.max_attempts AS "maxAttempts",
                  job.feature_total AS "featureTotal",job.feature_processed AS "featureProcessed",
                  job.failure_code AS "failureCode",job.result_snapshot_id AS "resultSnapshotId",
                  job.build_checksum AS "buildChecksum",snapshot.checksum AS "snapshotChecksum",
                  snapshot.generation::integer AS "resultGeneration",
                  job.lease_token IS NOT NULL AS "leasePresent",
                  job.lease_expires_at IS NOT NULL AND job.lease_expires_at<=now() AS "leaseExpired",
                  job.lease_expires_at AS "leaseExpiresAt",job.created_at AS "createdAt",
                  job.updated_at AS "updatedAt",job.finished_at AS "finishedAt"
           FROM publication_jobs job
           LEFT JOIN publication_snapshots snapshot ON snapshot.id=job.result_snapshot_id
           WHERE job.id=$1`,
          [jobId],
        ),
        'publication job',
      )
    : null;

  const evidence = {
    schemaVersion: 1,
    stage,
    runNonce,
    capturedAt: new Date().toISOString(),
    fixture,
    pointer,
    job,
    counts,
    worker,
  };
  assertStage(evidence);
  process.stdout.write(`DANANGMAP_EVIDENCE_JSON=${JSON.stringify(evidence)}\n`);
} finally {
  await client.end();
}

function assertStage(evidence) {
  const { fixture, pointer, job, counts, worker } = evidence;
  equal(fixture.slug, layerSlug, 'fixture slug');
  equal(fixture.expectedFeatureTotal, 3, 'fixture feature total');
  equal(fixture.runNonceFeatureTotal, 3, 'fixture run nonce feature total');
  equal(fixture.baselineRunNonceTotal, 0, 'baseline run nonce feature total');
  equal(fixture.runNoncePublicFieldTotal, 1, 'run nonce public field total');
  equal(fixture.publisherEditorialTotal, 0, 'publisher editorial participation');
  if (stage === 'seed') {
    equal(fixture.revisionStatus, 'approved', 'seed revision status');
    equal(pointer.generation, 1, 'seed generation');
    equal(pointer.activeRevisionId, fixture.publishedRevisionId, 'seed pointer revision');
    equal(counts.snapshots, 1, 'seed snapshot count');
    equal(counts.jobs, 0, 'seed job count');
    equal(counts.batches, 0, 'seed batch count');
    return;
  }

  equal(job.layerId, fixture.layerId, 'job layer');
  equal(job.revisionId, fixture.revisionId, 'job revision');
  equal(counts.jobs, 1, 'job count');
  if (stage === 'queue') {
    equal(fixture.revisionStatus, 'publishing', 'queued revision status');
    equal(job.status, 'queued', 'queued job status');
    equal(job.phase, 'queued', 'queued job phase');
    equal(job.attempts, 0, 'queued attempts');
    equal(job.featureTotal, null, 'queued feature total');
    equal(job.featureProcessed, 0, 'queued processed features');
    unchangedBaseline(pointer, counts);
    return;
  }
  if (stage === 'progress' || stage === 'crashed' || stage === 'lease-expired') {
    equal(fixture.revisionStatus, 'publishing', `${stage} revision status`);
    equal(job.status, 'building', `${stage} job status`);
    equal(job.phase, 'scanning_features', `${stage} job phase`);
    equal(job.attempts, 1, `${stage} attempts`);
    equal(job.featureTotal, 3, `${stage} measured total`);
    equal(job.featureProcessed, 1, `${stage} processed features`);
    equal(job.leasePresent, true, `${stage} lease presence`);
    equal(counts.batches, 1, `${stage} batch count`);
    equal(counts.batchFeatures, 1, `${stage} batch features`);
    equal(counts.projectionFeatures, 1, `${stage} projection features`);
    equal(counts.runNonceProjectionTotal, 1, `${stage} run nonce projection features`);
    equal(counts.privateProjectionTotal, 0, `${stage} private projection features`);
    unchangedBaseline(pointer, counts);
    if (stage === 'progress') equal(job.leaseExpired, false, 'progress live lease');
    if (stage === 'lease-expired') equal(job.leaseExpired, true, 'expired lease');
    return;
  }
  if (stage === 'terminal') {
    equal(fixture.revisionStatus, 'published', 'terminal revision status');
    equal(job.status, 'succeeded', 'terminal job status');
    equal(job.phase, 'completed', 'terminal job phase');
    atLeast(job.attempts, 2, 'terminal attempts');
    equal(job.featureTotal, 3, 'terminal measured total');
    equal(job.featureProcessed, 3, 'terminal processed features');
    equal(job.failureCode, null, 'terminal failure code');
    equal(job.leasePresent, false, 'terminal lease presence');
    equal(counts.batches, 3, 'terminal batch count');
    equal(counts.batchFeatures, 3, 'terminal batch features');
    equal(counts.projectionFeatures, 3, 'terminal projection features');
    equal(counts.runNonceProjectionTotal, 3, 'terminal run nonce projection features');
    equal(counts.privateProjectionTotal, 0, 'terminal private projection features');
    equal(counts.snapshots, 2, 'terminal snapshot count');
    equal(pointer.generation, 2, 'terminal generation');
    equal(pointer.previousSnapshotId, '60000000-0000-4000-8000-000000000004', 'previous pointer');
    equal(pointer.activeSnapshotId, job.resultSnapshotId, 'result pointer');
    equal(pointer.activeRevisionId, fixture.revisionId, 'terminal pointer revision');
    equal(job.resultGeneration, 2, 'result generation');
    equal(job.snapshotChecksum, job.buildChecksum, 'snapshot/build checksum');
    equal(counts.publishParticipants, 1, 'publish participant count');
    equal(counts.publishedWorkflowEvents, 1, 'published workflow event count');
    equal(counts.publishedAudits, 1, 'published audit count');
    equal(counts.queuedAudits, 1, 'queued audit count');
    atLeast(worker.recoveredLeases, 1, 'recovered lease count');
    atLeast(worker.completedJobs, 1, 'completed job count');
  }
}

function unchangedBaseline(pointer, counts) {
  equal(pointer.activeSnapshotId, '60000000-0000-4000-8000-000000000004', 'baseline pointer');
  equal(pointer.generation, 1, 'baseline generation');
  equal(counts.snapshots, 1, 'baseline snapshot count');
  equal(counts.publishParticipants, 0, 'preterminal publish participant count');
  equal(counts.publishedWorkflowEvents, 0, 'preterminal published workflow event count');
  equal(counts.publishedAudits, 0, 'preterminal published audit count');
}

function one(result, label) {
  if (result.rows.length !== 1)
    throw new Error(`Expected exactly one ${label}; got ${result.rows.length}.`);
  return result.rows[0];
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
    );
  }
}

function atLeast(actual, minimum, label) {
  if (typeof actual !== 'number' || actual < minimum) {
    throw new Error(`${label}: expected at least ${minimum}, got ${JSON.stringify(actual)}.`);
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function uuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
