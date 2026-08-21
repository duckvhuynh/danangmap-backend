import 'dotenv/config';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import AppDataSource from '../src/database/data-source';

const ids = {
  admin: '00000000-0000-4000-8000-000000000001',
  editor: '00000000-0000-4000-8000-000000000002',
  reviewer: '00000000-0000-4000-8000-000000000003',
  publisher: '00000000-0000-4000-8000-000000000004',
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

async function seedUsers(): Promise<void> {
  const secret = process.env.SEED_MFA_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const users = [
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
  ] as const;
  for (const [id, username, email, displayName, role, passwordVariable] of users) {
    const password = process.env[passwordVariable] ?? `ChangeMe-${username}-2026!`;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await AppDataSource.query(
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
          updated_at=now()
      `,
      [id, email, username, displayName, role, passwordHash, encrypted(secret)],
    );
  }
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
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SEED !== 'true') {
    throw new Error('Production seed is disabled unless ALLOW_SEED=true');
  }
  await AppDataSource.initialize();
  try {
    await seedUsers();
    await seedCatalog();
  } finally {
    await AppDataSource.destroy();
  }
}

void main();
