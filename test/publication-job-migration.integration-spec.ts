import { randomUUID } from 'node:crypto';
import AppDataSource from '../src/database/data-source';

jest.setTimeout(60_000);

describe('durable publication job migration constraints', () => {
  const userId = randomUUID();
  const groupId = randomUUID();
  const layerId = randomUUID();
  const revisionId = randomUUID();
  const jobId = randomUUID();

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    await AppDataSource.query(
      `INSERT INTO users(
         id,email,email_normalized,username,username_normalized,display_name,role,status,password_hash
       ) VALUES($1,$2,$2,$3,$3,'Publication migration','publisher','active','test-hash')`,
      [userId, `publication-migration-${userId}@example.vn`, `publication_${userId}`],
    );
    await AppDataSource.query(
      `INSERT INTO layer_groups(id,slug,title) VALUES($1,$2,'Publication migration group')`,
      [groupId, `publication-migration-${groupId}`],
    );
    await AppDataSource.query(
      `INSERT INTO layers(id,slug,group_id,created_by) VALUES($1,$2,$3,$4)`,
      [layerId, `publication-migration-${layerId}`, groupId, userId],
    );
    await AppDataSource.query(
      `INSERT INTO layer_revisions(
         id,layer_id,revision_no,status,title,geometry_mode,allowed_geometry_kinds,created_by
       ) VALUES($1,$2,1,'publishing','Publication migration','point','{point}',$3)`,
      [revisionId, layerId, userId],
    );
    await AppDataSource.query(
      `INSERT INTO publication_jobs(
         id,layer_id,revision_id,requested_by,request_id,client_intent,release_note,
         revision_lock_version,revision_schema_version,revision_fingerprint
       ) VALUES($1,$2,$3,$4,$5,'desktop','Migration constraint fixture',1,1,$6)`,
      [jobId, layerId, revisionId, userId, randomUUID(), 'a'.repeat(64)],
    );
    await AppDataSource.query(`INSERT INTO publication_job_outbox(publication_job_id) VALUES($1)`, [
      jobId,
    ]);
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    await AppDataSource.query(`DELETE FROM publication_jobs WHERE id=$1`, [jobId]);
    await AppDataSource.query(`DELETE FROM layer_revisions WHERE id=$1`, [revisionId]);
    await AppDataSource.query(`DELETE FROM layers WHERE id=$1`, [layerId]);
    await AppDataSource.query(`DELETE FROM layer_groups WHERE id=$1`, [groupId]);
    await AppDataSource.query(`DELETE FROM users WHERE id=$1`, [userId]);
    await AppDataSource.destroy();
  });

  it('creates the durable tables and cursor/dispatch indexes', async () => {
    const tables = (await AppDataSource.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=current_schema() AND table_name LIKE 'publication_job%'
       ORDER BY table_name`,
    )) as Array<{ table_name: string }>;
    expect(tables.map((row) => row.table_name)).toEqual([
      'publication_job_batches',
      'publication_job_outbox',
      'publication_jobs',
    ]);
    const workerState = (await AppDataSource.query(
      `SELECT id,reconciliation_cursor_available_at,reconciliation_cursor_created_at,
              reconciliation_cursor_job_id,dispatch_error_code,worker_error_code
       FROM publication_worker_state`,
    )) as Array<Record<string, unknown>>;
    expect(workerState).toHaveLength(1);
    expect(workerState[0]?.id).toBe(1);
    const cursorPresence = [
      workerState[0]?.reconciliation_cursor_available_at,
      workerState[0]?.reconciliation_cursor_created_at,
      workerState[0]?.reconciliation_cursor_job_id,
    ].map(Boolean);
    expect(cursorPresence).toEqual([cursorPresence[0], cursorPresence[0], cursorPresence[0]]);
    expect(workerState[0]?.dispatch_error_code).toBeNull();
    expect(workerState[0]?.worker_error_code).toBeNull();
    const receiptMetadataColumn = (await AppDataSource.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='command_receipts'
         AND column_name='response_metadata'`,
    )) as Array<{ data_type: string }>;
    expect(receiptMetadataColumn).toEqual([{ data_type: 'jsonb' }]);
    const builderColumns = (await AppDataSource.query(
      `SELECT table_name,column_name,data_type FROM information_schema.columns
       WHERE table_schema=current_schema() AND (
         (table_name='publication_job_batches' AND column_name='public_projection')
         OR (table_name='publication_worker_state' AND column_name=ANY(
           '{last_recovery_sweep_at,reconciliation_cursor_available_at,dispatch_error_code,worker_error_code}'::text[]
         ))
       ) ORDER BY table_name,column_name`,
    )) as Array<Record<string, unknown>>;
    expect(builderColumns).toHaveLength(5);
    const indexes = (await AppDataSource.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname=current_schema() AND indexname=ANY($1::text[]) ORDER BY indexname`,
      [
        [
          'idx_publication_job_layer_cursor',
          'idx_publication_job_reconciliation_available',
          'idx_publication_job_revision_cursor',
          'idx_publication_outbox_dispatch',
          'uq_publication_job_active_layer',
        ],
      ],
    )) as Array<{ indexname: string }>;
    expect(indexes.map((row) => row.indexname)).toHaveLength(5);
  });

  it('enforces one active job and immutable/monotonic state', async () => {
    await expect(
      AppDataSource.query(
        `INSERT INTO publication_jobs(
           layer_id,revision_id,requested_by,request_id,client_intent,release_note,
           revision_lock_version,revision_schema_version,revision_fingerprint
         ) VALUES($1,$2,$3,$4,'desktop','Duplicate active job',1,1,$5)`,
        [layerId, revisionId, userId, randomUUID(), 'b'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_publication_job_active_layer' });

    await AppDataSource.query(
      `UPDATE publication_jobs
       SET status='building',phase='preparing',started_at=now(),feature_total=10,
           feature_processed=5,lease_token=$2,lease_owner='migration-test',
           lease_expires_at=now()+interval '1 minute',lock_version=lock_version+1 WHERE id=$1`,
      [jobId, randomUUID()],
    );
    await expect(
      AppDataSource.query(
        `INSERT INTO publication_job_batches(
           job_id,batch_no,first_feature_id,last_feature_id,feature_count,vertex_count,
           public_checksum,public_projection
         ) VALUES($1,1,$2,$2,1,1,$3,'[]'::jsonb)`,
        [jobId, randomUUID(), 'c'.repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      AppDataSource.query(
        `UPDATE publication_jobs SET feature_processed=4,lock_version=lock_version+1 WHERE id=$1`,
        [jobId],
      ),
    ).rejects.toThrow('publication job progress cannot regress');
    await expect(
      AppDataSource.query(
        `UPDATE publication_jobs SET release_note='mutated',lock_version=lock_version+1 WHERE id=$1`,
        [jobId],
      ),
    ).rejects.toThrow('publication job identity is immutable');
    await expect(
      AppDataSource.query(
        `UPDATE publication_job_outbox SET publication_job_id=$2 WHERE publication_job_id=$1`,
        [jobId, randomUUID()],
      ),
    ).rejects.toThrow();
  });
});
