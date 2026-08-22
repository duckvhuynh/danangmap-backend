import 'dotenv/config';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { EntityManager } from 'typeorm';
import AppDataSource from '../src/database/data-source';
import { assertE2eAuthResetAllowed } from './e2e-auth-reset-guard';

const ids = {
  admin: '00000000-0000-4000-8000-000000000001',
  editor: '00000000-0000-4000-8000-000000000002',
  reviewer: '00000000-0000-4000-8000-000000000003',
  publisher: '00000000-0000-4000-8000-000000000004',
  rollbackPublisher: '00000000-0000-4000-8000-000000000005',
  groupEducation: '10000000-0000-4000-8000-000000000001',
  groupAdmin: '10000000-0000-4000-8000-000000000002',
  schoolLayer: '20000000-0000-4000-8000-000000000001',
  boundaryLayer: '20000000-0000-4000-8000-000000000002',
  schoolRevision: '30000000-0000-4000-8000-000000000001',
  boundaryRevision: '30000000-0000-4000-8000-000000000002',
  schoolFeature: '40000000-0000-4000-8000-000000000001',
  boundaryFeature: '40000000-0000-4000-8000-000000000002',
  schoolVersion: '50000000-0000-4000-8000-000000000001',
  boundaryVersion: '50000000-0000-4000-8000-000000000002',
  schoolSnapshot: '60000000-0000-4000-8000-000000000001',
  boundarySnapshot: '60000000-0000-4000-8000-000000000002',
  workflowLayer: '20000000-0000-4000-8000-000000000003',
  workflowPublishedRevision: '30000000-0000-4000-8000-000000000003',
  workflowDraftRevision: '30000000-0000-4000-8000-000000000004',
  workflowFeature: '40000000-0000-4000-8000-000000000003',
  workflowVersion: '50000000-0000-4000-8000-000000000003',
  workflowSnapshot: '60000000-0000-4000-8000-000000000003',
  activationLayer: '20000000-0000-4000-8000-000000000004',
  activationPublishedRevision: '30000000-0000-4000-8000-000000000005',
  activationApprovedRevision: '30000000-0000-4000-8000-000000000006',
  activationBaselineFeature: '40000000-0000-4000-8000-000000000004',
  activationFeatureOne: '40000000-0000-4000-8000-000000000005',
  activationFeatureTwo: '40000000-0000-4000-8000-000000000006',
  activationFeatureThree: '40000000-0000-4000-8000-000000000007',
  activationBaselineVersion: '50000000-0000-4000-8000-000000000004',
  activationVersionOne: '50000000-0000-4000-8000-000000000005',
  activationVersionTwo: '50000000-0000-4000-8000-000000000006',
  activationVersionThree: '50000000-0000-4000-8000-000000000007',
  activationSnapshot: '60000000-0000-4000-8000-000000000004',
} as const;

const schoolGeometry = { type: 'Point', coordinates: [108.24620601721108, 16.047487976029515] };
const boundaryGeometry = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [108.518184, 15.630393],
        [108.520116, 15.623974],
        [108.507673, 15.62252],
        [108.499254, 15.615524],
        [108.483801, 15.606697],
        [108.472435, 15.595079],
        [108.471528, 15.590854],
        [108.48321, 15.587786],
        [108.497037, 15.611053],
        [108.518184, 15.630393],
      ],
    ],
  ],
};
const workflowGeometry = { type: 'Point', coordinates: [108.215, 16.072] };

const seedActors = [
  [
    ids.admin,
    'admin',
    'system-admin@danangmap.local',
    'Quản trị hệ thống',
    'system_admin',
    'SEED_ADMIN_PASSWORD',
  ],
  [
    ids.editor,
    'editor',
    'editor@danangmap.local',
    'Biên tập viên',
    'editor',
    'SEED_EDITOR_PASSWORD',
  ],
  [
    ids.reviewer,
    'reviewer',
    'reviewer@danangmap.local',
    'Kiểm duyệt viên',
    'reviewer',
    'SEED_REVIEWER_PASSWORD',
  ],
  [
    ids.publisher,
    'publisher',
    'publisher@danangmap.local',
    'Xuất bản viên',
    'publisher',
    'SEED_PUBLISHER_PASSWORD',
  ],
  [
    ids.rollbackPublisher,
    'rollback-publisher',
    'rollback-publisher@danangmap.local',
    'Xuất bản viên rollback',
    'publisher',
    'SEED_ROLLBACK_PUBLISHER_PASSWORD',
  ],
] as const;

function encrypted(value: string): string {
  const key = createHash('sha256')
    .update(process.env.FIELD_ENCRYPTION_KEY ?? '')
    .digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), payload].map((part) => part.toString('base64url')).join('.');
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function seedUsers(
  manager?: EntityManager,
  resetSecurityState = false,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const queryRunner = manager ?? AppDataSource;
  const secret = environment.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  for (const [id, username, email, displayName, role, passwordVariable] of seedActors) {
    const password = environment[passwordVariable] ?? `ChangeMe-${username}-2026!`;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const encryptedSecret = encrypted(secret);
    await queryRunner.query(
      `
        INSERT INTO users(
          id,email,email_normalized,username,username_normalized,display_name,role,status,
          password_hash,mfa_enabled,mfa_secret_encrypted
        ) VALUES($1,$2,lower($2),$3,lower($3),$4,$5,'active',$6,true,$7)
        ON CONFLICT(id) DO UPDATE SET
          email=EXCLUDED.email,email_normalized=EXCLUDED.email_normalized,
          username=EXCLUDED.username,username_normalized=EXCLUDED.username_normalized,
          display_name=EXCLUDED.display_name,role=EXCLUDED.role,status='active',
          password_hash=EXCLUDED.password_hash,mfa_enabled=true,mfa_secret_encrypted=EXCLUDED.mfa_secret_encrypted,
          must_change_password=CASE WHEN $8 THEN false ELSE users.must_change_password END,
          failed_login_count=CASE WHEN $8 THEN 0 ELSE users.failed_login_count END,
          locked_until=CASE WHEN $8 THEN NULL ELSE users.locked_until END,
          disabled_at=CASE WHEN $8 THEN NULL ELSE users.disabled_at END,
          updated_at=now()
      `,
      [id, email, username, displayName, role, passwordHash, encryptedSecret, resetSecurityState],
    );
    await queryRunner.query(
      `INSERT INTO user_mfa_methods(user_id,status,secret_encrypted,verified_at)
       VALUES($1,'verified',$2,now())
       ON CONFLICT(user_id) DO UPDATE SET
         status='verified',secret_encrypted=EXCLUDED.secret_encrypted,
         last_used_time_step=CASE WHEN $3 THEN NULL ELSE user_mfa_methods.last_used_time_step END,
         enrollment_session_id=NULL,
         verified_at=COALESCE(user_mfa_methods.verified_at,now()),updated_at=now()`,
      [id, encryptedSecret, resetSecurityState],
    );
  }
}

export async function resetE2eSeededAuth(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertE2eAuthResetAllowed(environment);
  const actorIds = seedActors.map(([id]) => id);
  await AppDataSource.transaction(async (manager) => {
    const identities = (await manager.query(
      'SELECT id,username,email,role FROM users WHERE id=ANY($1::uuid[])',
      [actorIds],
    )) as Array<{ id: string; username: string; email: string; role: string }>;
    const identitiesById = new Map(identities.map((identity) => [identity.id, identity]));
    const identityMismatch = seedActors.some(([id, username, email, , role]) => {
      const identity = identitiesById.get(id);
      return (
        !identity ||
        identity.username !== username ||
        identity.email !== email ||
        identity.role !== role
      );
    });
    if (identities.length !== seedActors.length || identityMismatch) {
      throw new Error('E2E auth reset refused an unexpected seeded actor identity set');
    }
    await manager.query(
      `UPDATE admin_sessions
       SET revoked_at=COALESCE(revoked_at,now()),mfa_failed_attempts=0,mfa_locked_until=NULL
       WHERE user_id=ANY($1::uuid[])`,
      [actorIds],
    );
    await manager.query('DELETE FROM user_mfa_recovery_codes WHERE user_id=ANY($1::uuid[])', [
      actorIds,
    ]);
    await manager.query(
      `UPDATE password_reset_tokens SET revoked_at=COALESCE(revoked_at,now())
       WHERE user_id=ANY($1::uuid[]) AND used_at IS NULL`,
      [actorIds],
    );
    await seedUsers(manager, true, environment);
  });
}

async function seedCatalog(): Promise<void> {
  await AppDataSource.query(
    `
      INSERT INTO layer_groups(id,slug,title,description,display_order,default_visible)
      VALUES
        ($1,'education','Giáo dục','Cơ sở giáo dục trên địa bàn.',20,true),
        ($2,'administration','Hành chính','Ranh giới và dữ liệu hành chính.',10,true)
      ON CONFLICT(id) DO NOTHING
    `,
    [ids.groupEducation, ids.groupAdmin],
  );
  await AppDataSource.query(
    `
      INSERT INTO layers(id,slug,group_id,display_order,created_by)
      VALUES
        ($1,'schools',$2,10,$3),
        ($4,'new-wards',$5,10,$3)
      ON CONFLICT(id) DO NOTHING
    `,
    [ids.schoolLayer, ids.groupEducation, ids.editor, ids.boundaryLayer, ids.groupAdmin],
  );
  await AppDataSource.query(
    `
      INSERT INTO layer_revisions(
        id,layer_id,revision_no,status,title,description,geometry_mode,allowed_geometry_kinds,
        style,render_config,popup_config,schema_version,lock_version,cursor_seq,created_by,
        submitted_at,approved_at,published_at
      ) VALUES
        ($1,$2,1,'published','Trường học','Subset xác định từ school.json v1.','point',ARRAY['point'],
         '{"point":{"color":"#1A73E8","radius":7,"cluster":true}}',
         '{"minZoom":8,"maxZoom":18,"cluster":true,"sourcePolicy":"geojson"}',
         '{"titleField":"name","fieldKeys":["name","address","phone"],"showCoordinates":false}',
         1,1,0,$3,now(),now(),now()),
        ($4,$5,1,'published','Ranh giới xã phường mới','Subset rút gọn từ new-boundaries.geojson v1.','polygon',ARRAY['multipolygon'],
         '{"polygon":{"fillColor":"#EAF3FF","fillOpacity":0.35,"strokeColor":"#1A73E8","strokeWidth":2}}',
         '{"minZoom":7,"maxZoom":18,"cluster":false,"sourcePolicy":"geojson"}',
         '{"titleField":"name","fieldKeys":["name","type","population"],"showCoordinates":false}',
         1,1,0,$3,now(),now(),now())
      ON CONFLICT(id) DO NOTHING
    `,
    [ids.schoolRevision, ids.schoolLayer, ids.editor, ids.boundaryRevision, ids.boundaryLayer],
  );
  await AppDataSource.query(
    `
      INSERT INTO layer_fields(revision_id,key,label,type,icon,required,public,searchable,filterable,sortable,display_order)
      VALUES
        ($1,'name','Tên','text','school',true,true,true,false,true,10),
        ($1,'address','Địa chỉ','address','map-pin',false,true,true,false,false,20),
        ($1,'phone','Số điện thoại','phone','phone',false,true,true,false,false,30),
        ($1,'internal_note','Ghi chú nội bộ','long_text','note',false,false,false,false,false,40),
        ($2,'name','Tên xã/phường','text','map',true,true,true,false,true,10),
        ($2,'type','Loại','enum','category',true,true,false,true,false,20),
        ($2,'population','Dân số','integer','users',false,true,false,false,true,30)
      ON CONFLICT(revision_id,key) DO NOTHING
    `,
    [ids.schoolRevision, ids.boundaryRevision],
  );
  const schoolProperties = {
    name: 'Trường cao đẳng văn hóa nghệ thuật',
    address: '130 Lê Quang Đạo, Phường Ngũ Hành Sơn',
    phone: '0236 2248132',
    internal_note: 'Không được xuất hiện trên public API',
  };
  const boundaryProperties = { name: 'Bàn Thạch', type: 'Phường', population: 36800 };
  await AppDataSource.query(
    `INSERT INTO features(id,layer_id,external_source,external_id)
     VALUES($1,$2,'danang-v1','school-0001'),($3,$4,'danang-v1','ward-20335')
     ON CONFLICT(id) DO NOTHING`,
    [ids.schoolFeature, ids.schoolLayer, ids.boundaryFeature, ids.boundaryLayer],
  );
  await AppDataSource.query(
    `
      INSERT INTO feature_versions(id,feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by)
      VALUES
        ($1,$2,$3,ST_SetSRID(ST_GeomFromGeoJSON($4),4326),'point',$5::jsonb,NULL,$6,$7),
        ($8,$9,$10,ST_SetSRID(ST_GeomFromGeoJSON($11),4326),'multipolygon',$12::jsonb,NULL,$13,$7)
      ON CONFLICT(id) DO NOTHING
    `,
    [
      ids.schoolVersion,
      ids.schoolFeature,
      ids.schoolRevision,
      JSON.stringify(schoolGeometry),
      JSON.stringify(schoolProperties),
      checksum({ schoolGeometry, schoolProperties }),
      ids.editor,
      ids.boundaryVersion,
      ids.boundaryFeature,
      ids.boundaryRevision,
      JSON.stringify(boundaryGeometry),
      JSON.stringify(boundaryProperties),
      checksum({ boundaryGeometry, boundaryProperties }),
    ],
  );
  await AppDataSource.query(
    `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
     VALUES($1,$2,$3,1),($4,$5,$6,1) ON CONFLICT DO NOTHING`,
    [
      ids.schoolRevision,
      ids.schoolFeature,
      ids.schoolVersion,
      ids.boundaryRevision,
      ids.boundaryFeature,
      ids.boundaryVersion,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO revision_participants(revision_id,user_id,participation_type)
     VALUES
       ($1,$3,'edit'),($1,$4,'review'),($1,$5,'publish'),
       ($2,$3,'edit'),($2,$4,'review'),($2,$5,'publish')
     ON CONFLICT DO NOTHING`,
    [ids.schoolRevision, ids.boundaryRevision, ids.editor, ids.reviewer, ids.publisher],
  );
  await AppDataSource.query(
    `
      INSERT INTO publication_snapshots(
        id,layer_id,revision_id,status,generation,feature_count,bounds,checksum,manifest,published_by,published_at
      ) VALUES
        ($1,$2,$3,'published',1,1,ARRAY[108.246206,16.047488,108.246206,16.047488],$4,
         '{"sourceKind":"geojson","sourceLayer":"features","seedSubset":true}',$5,now()),
        ($6,$7,$8,'published',1,1,ARRAY[108.471528,15.587786,108.520116,15.630393],$9,
         '{"sourceKind":"geojson","sourceLayer":"features","seedSubset":true}',$5,now())
      ON CONFLICT(id) DO NOTHING
    `,
    [
      ids.schoolSnapshot,
      ids.schoolLayer,
      ids.schoolRevision,
      checksum(ids.schoolFeature),
      ids.publisher,
      ids.boundarySnapshot,
      ids.boundaryLayer,
      ids.boundaryRevision,
      checksum(ids.boundaryFeature),
    ],
  );
  await AppDataSource.query(
    `INSERT INTO layer_publications(layer_id,active_snapshot_id,pointer_updated_at)
     VALUES($1,$2,now()),($3,$4,now())
     ON CONFLICT(layer_id) DO UPDATE SET active_snapshot_id=EXCLUDED.active_snapshot_id,pointer_updated_at=now()`,
    [ids.schoolLayer, ids.schoolSnapshot, ids.boundaryLayer, ids.boundarySnapshot],
  );

  if (process.env.SEED_CROSSSTACK_FIXTURES === 'true') {
    await seedCrossStackPublicationFixture();
  }
  if (process.env.SEED_DURABLE_PUBLICATION_FIXTURE === 'true') {
    await seedDurablePublicationActivationFixture();
  }
}

async function seedCrossStackPublicationFixture(): Promise<void> {
  await AppDataSource.query(
    `INSERT INTO layers(id,slug,group_id,display_order,created_by)
     VALUES($1,'cross-stack-publication',$2,90,$3)
     ON CONFLICT(id) DO NOTHING`,
    [ids.workflowLayer, ids.groupEducation, ids.editor],
  );
  await AppDataSource.query(
    `
      INSERT INTO layer_revisions(
        id,layer_id,revision_no,status,title,description,geometry_mode,allowed_geometry_kinds,
        style,render_config,popup_config,schema_version,lock_version,cursor_seq,created_by,
        submitted_at,approved_at,published_at,supersedes_revision_id
      ) VALUES
        ($1,$2,1,'published','Điểm kiểm thử công bố','Baseline công khai chỉ dành cho cross-stack E2E.',
         'point',ARRAY['point'],'{"point":{"color":"#1A73E8","radius":7,"cluster":false}}',
         '{"minZoom":8,"maxZoom":18,"cluster":false,"sourcePolicy":"geojson"}',
         '{"titleField":"name","fieldKeys":["name","address"],"showCoordinates":false}',
         1,1,0,$3,now(),now(),now(),NULL),
        ($4,$2,2,'draft','Điểm kiểm thử công bố','Draft xác định cho Editor → Reviewer → Publisher E2E.',
         'point',ARRAY['point'],'{"point":{"color":"#1A73E8","radius":7,"cluster":false}}',
         '{"minZoom":8,"maxZoom":18,"cluster":false,"sourcePolicy":"geojson"}',
         '{"titleField":"name","fieldKeys":["name","address"],"showCoordinates":false}',
         1,1,0,$3,NULL,NULL,NULL,$1)
      ON CONFLICT(id) DO NOTHING
    `,
    [ids.workflowPublishedRevision, ids.workflowLayer, ids.editor, ids.workflowDraftRevision],
  );
  await AppDataSource.query(
    `
      INSERT INTO layer_fields(
        revision_id,key,label,type,icon,required,public,searchable,filterable,sortable,display_order
      ) VALUES
        ($1,'name','Tên điểm','text','map-pin',true,true,true,false,true,10),
        ($1,'address','Địa chỉ','address','map-pin',false,true,true,false,false,20),
        ($1,'internal_note','Ghi chú nội bộ','long_text','note',false,false,false,false,false,30),
        ($2,'name','Tên điểm','text','map-pin',true,true,true,false,true,10),
        ($2,'address','Địa chỉ','address','map-pin',false,true,true,false,false,20),
        ($2,'internal_note','Ghi chú nội bộ','long_text','note',false,false,false,false,false,30)
      ON CONFLICT(revision_id,key) DO NOTHING
    `,
    [ids.workflowPublishedRevision, ids.workflowDraftRevision],
  );
  const properties = {
    name: 'Điểm nền Gate B',
    address: 'Trung tâm hành chính Đà Nẵng',
    internal_note: 'Baseline private field must never be public',
  };
  await AppDataSource.query(
    `INSERT INTO features(id,layer_id,external_source,external_id)
     VALUES($1,$2,'cross-stack-seed','baseline-1')
     ON CONFLICT(id) DO NOTHING`,
    [ids.workflowFeature, ids.workflowLayer],
  );
  await AppDataSource.query(
    `INSERT INTO feature_versions(
       id,feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by
     ) VALUES(
       $1,$2,$3,ST_SetSRID(ST_GeomFromGeoJSON($4),4326),'point',$5::jsonb,NULL,$6,$7
     ) ON CONFLICT(id) DO NOTHING`,
    [
      ids.workflowVersion,
      ids.workflowFeature,
      ids.workflowPublishedRevision,
      JSON.stringify(workflowGeometry),
      JSON.stringify(properties),
      checksum({ workflowGeometry, properties }),
      ids.editor,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal)
     VALUES($1,$3,$4,1),($2,$3,$4,1)
     ON CONFLICT DO NOTHING`,
    [
      ids.workflowPublishedRevision,
      ids.workflowDraftRevision,
      ids.workflowFeature,
      ids.workflowVersion,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO revision_participants(revision_id,user_id,participation_type)
     VALUES
       ($1,$3,'edit'),($1,$4,'review'),($1,$5,'publish'),
       ($2,$3,'edit')
     ON CONFLICT DO NOTHING`,
    [
      ids.workflowPublishedRevision,
      ids.workflowDraftRevision,
      ids.editor,
      ids.reviewer,
      ids.publisher,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO publication_snapshots(
       id,layer_id,revision_id,status,generation,feature_count,bounds,checksum,manifest,published_by,published_at
     ) VALUES(
       $1,$2,$3,'published',1,1,ARRAY[108.215,16.072,108.215,16.072],$4,
       '{"sourceKind":"geojson","sourceLayer":"features","crossStackFixture":true}',$5,now()
     ) ON CONFLICT(id) DO NOTHING`,
    [
      ids.workflowSnapshot,
      ids.workflowLayer,
      ids.workflowPublishedRevision,
      checksum(ids.workflowFeature),
      ids.publisher,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO layer_publications(layer_id,active_snapshot_id,pointer_updated_at)
     VALUES($1,$2,now())
     ON CONFLICT(layer_id) DO NOTHING`,
    [ids.workflowLayer, ids.workflowSnapshot],
  );
}

async function seedDurablePublicationActivationFixture(): Promise<void> {
  const runNonce = process.env.DANANGMAP_RUN_NONCE?.trim();
  if (!runNonce || !/^[a-z0-9-]{16,128}$/u.test(runNonce)) {
    throw new Error('DANANGMAP_RUN_NONCE is required for the durable publication fixture');
  }
  const baselineGeometry = { type: 'Point', coordinates: [108.221, 16.068] };
  const successorGeometries = [
    { type: 'Point', coordinates: [108.222, 16.0685] },
    { type: 'Point', coordinates: [108.223, 16.069] },
    { type: 'Point', coordinates: [108.224, 16.0695] },
  ];
  const baselineProperties = {
    name: 'Durable activation baseline',
    address: 'Đà Nẵng',
    internal_note: 'Never public: durable activation baseline',
  };
  const successorProperties = successorGeometries.map((_, index) => ({
    name: `Durable activation feature ${index + 1}`,
    address: `Điểm kiểm thử ${index + 1}, Đà Nẵng`,
    activation_run_nonce: runNonce,
    internal_note: `Never public: durable activation ${index + 1}`,
  }));

  await AppDataSource.query(
    `INSERT INTO layers(id,slug,group_id,display_order,created_by)
     VALUES($1,'durable-publication-activation',$2,91,$3)
     ON CONFLICT(id) DO NOTHING`,
    [ids.activationLayer, ids.groupEducation, ids.editor],
  );
  await AppDataSource.query(
    `INSERT INTO layer_revisions(
       id,layer_id,revision_no,status,title,description,geometry_mode,allowed_geometry_kinds,
       style,render_config,popup_config,schema_version,lock_version,cursor_seq,created_by,
       submitted_at,approved_at,published_at,supersedes_revision_id
     ) VALUES
       ($1,$2,1,'published','Durable publication activation',
        'Generation-one baseline for the exact-SHA activation harness.',
        'point',ARRAY['point'],'{"point":{"color":"#1A73E8","radius":7,"cluster":false}}',
        '{"minZoom":8,"maxZoom":18,"cluster":false,"sourcePolicy":"geojson"}',
        '{"titleField":"name","fieldKeys":["name","address"],"showCoordinates":false}',
        1,1,0,$3,now(),now(),now(),NULL),
       ($4,$2,2,'approved','Durable publication activation',
        'Approved three-feature successor reserved for crash/recovery acceptance.',
        'point',ARRAY['point'],'{"point":{"color":"#1A73E8","radius":7,"cluster":false}}',
        '{"minZoom":8,"maxZoom":18,"cluster":false,"sourcePolicy":"geojson"}',
        '{"titleField":"name","fieldKeys":["name","address"],"showCoordinates":false}',
        1,3,3,$3,now(),now(),NULL,$1)
     ON CONFLICT(id) DO NOTHING`,
    [
      ids.activationPublishedRevision,
      ids.activationLayer,
      ids.editor,
      ids.activationApprovedRevision,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO layer_fields(
       revision_id,key,label,type,icon,required,public,searchable,filterable,sortable,display_order
     ) VALUES
       ($1,'name','Tên điểm','text','map-pin',true,true,true,false,true,10),
       ($1,'address','Địa chỉ','address','map-pin',false,true,true,false,false,20),
       ($1,'internal_note','Ghi chú nội bộ','long_text','note',false,false,false,false,false,30),
       ($2,'name','Tên điểm','text','map-pin',true,true,true,false,true,10),
       ($2,'address','Địa chỉ','address','map-pin',false,true,true,false,false,20),
       ($2,'activation_run_nonce','Mã lần chạy','text','hash',true,true,false,false,false,25),
       ($2,'internal_note','Ghi chú nội bộ','long_text','note',false,false,false,false,false,30)
     ON CONFLICT(revision_id,key) DO NOTHING`,
    [ids.activationPublishedRevision, ids.activationApprovedRevision],
  );
  await AppDataSource.query(
    `INSERT INTO features(id,layer_id,external_source,external_id) VALUES
       ($1,$5,'activation-seed','baseline'),
       ($2,$5,'activation-seed','successor-1'),
       ($3,$5,'activation-seed','successor-2'),
       ($4,$5,'activation-seed','successor-3')
     ON CONFLICT(id) DO NOTHING`,
    [
      ids.activationBaselineFeature,
      ids.activationFeatureOne,
      ids.activationFeatureTwo,
      ids.activationFeatureThree,
      ids.activationLayer,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO feature_versions(
       id,feature_id,revision_id,geometry,geometry_kind,properties,radius_m,checksum,created_by
     ) VALUES
       ($1,$2,$3,ST_SetSRID(ST_GeomFromGeoJSON($4),4326),'point',$5::jsonb,NULL,$6,$7),
       ($8,$9,$10,ST_SetSRID(ST_GeomFromGeoJSON($11),4326),'point',$12::jsonb,NULL,$13,$7),
       ($14,$15,$10,ST_SetSRID(ST_GeomFromGeoJSON($16),4326),'point',$17::jsonb,NULL,$18,$7),
       ($19,$20,$10,ST_SetSRID(ST_GeomFromGeoJSON($21),4326),'point',$22::jsonb,NULL,$23,$7)
     ON CONFLICT(id) DO NOTHING`,
    [
      ids.activationBaselineVersion,
      ids.activationBaselineFeature,
      ids.activationPublishedRevision,
      JSON.stringify(baselineGeometry),
      JSON.stringify(baselineProperties),
      checksum({ geometry: baselineGeometry, properties: baselineProperties }),
      ids.editor,
      ids.activationVersionOne,
      ids.activationFeatureOne,
      ids.activationApprovedRevision,
      JSON.stringify(successorGeometries[0]),
      JSON.stringify(successorProperties[0]),
      checksum({ geometry: successorGeometries[0], properties: successorProperties[0] }),
      ids.activationVersionTwo,
      ids.activationFeatureTwo,
      JSON.stringify(successorGeometries[1]),
      JSON.stringify(successorProperties[1]),
      checksum({ geometry: successorGeometries[1], properties: successorProperties[1] }),
      ids.activationVersionThree,
      ids.activationFeatureThree,
      JSON.stringify(successorGeometries[2]),
      JSON.stringify(successorProperties[2]),
      checksum({ geometry: successorGeometries[2], properties: successorProperties[2] }),
    ],
  );
  await AppDataSource.query(
    `INSERT INTO revision_features(revision_id,feature_id,feature_version_id,ordinal) VALUES
       ($1,$2,$3,1),
       ($4,$5,$6,1),($4,$7,$8,2),($4,$9,$10,3)
     ON CONFLICT DO NOTHING`,
    [
      ids.activationPublishedRevision,
      ids.activationBaselineFeature,
      ids.activationBaselineVersion,
      ids.activationApprovedRevision,
      ids.activationFeatureOne,
      ids.activationVersionOne,
      ids.activationFeatureTwo,
      ids.activationVersionTwo,
      ids.activationFeatureThree,
      ids.activationVersionThree,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO revision_participants(revision_id,user_id,participation_type) VALUES
       ($1,$3,'edit'),($1,$4,'review'),($1,$5,'publish'),
       ($2,$3,'edit'),($2,$4,'review')
     ON CONFLICT DO NOTHING`,
    [
      ids.activationPublishedRevision,
      ids.activationApprovedRevision,
      ids.editor,
      ids.reviewer,
      ids.publisher,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO publication_snapshots(
       id,layer_id,revision_id,status,generation,feature_count,bounds,checksum,manifest,
       published_by,published_at,activated_at
     ) VALUES(
       $1,$2,$3,'published',1,1,ARRAY[108.221,16.068,108.221,16.068],$4,
       '{"sourceKind":"geojson","sourceLayer":"features","activationFixture":true}',
       $5,now(),now()
     ) ON CONFLICT(id) DO NOTHING`,
    [
      ids.activationSnapshot,
      ids.activationLayer,
      ids.activationPublishedRevision,
      checksum(ids.activationBaselineFeature),
      ids.publisher,
    ],
  );
  await AppDataSource.query(
    `INSERT INTO layer_publications(layer_id,active_snapshot_id,pointer_updated_at)
     VALUES($1,$2,now()) ON CONFLICT(layer_id) DO NOTHING`,
    [ids.activationLayer, ids.activationSnapshot],
  );
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== 'true') {
    throw new Error('Production seed is disabled unless ALLOW_SEED=true');
  }
  await AppDataSource.initialize();
  try {
    if (process.env.DANANGMAP_E2E_AUTH_RESET === 'true') {
      await resetE2eSeededAuth();
      return;
    }
    await seedUsers();
    await seedCatalog();
  } finally {
    await AppDataSource.destroy();
  }
}

if (require.main === module) void main();
