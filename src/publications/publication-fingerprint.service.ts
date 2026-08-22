import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';

@Injectable()
export class PublicationFingerprintService {
  constructor(private readonly crypto: CryptoService) {}

  async calculate(manager: EntityManager, revisionId: string): Promise<string> {
    const rows = (await manager.query(
      `SELECT jsonb_build_object(
         'id',revision.id,
         'layerId',revision.layer_id,
         'geometryMode',revision.geometry_mode,
         'allowedGeometryKinds',revision.allowed_geometry_kinds,
         'style',revision.style,
         'renderConfig',revision.render_config,
         'popupConfig',revision.popup_config,
         'schemaVersion',revision.schema_version,
         'cursorSeq',revision.cursor_seq,
         'fields',COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'id',field.id,'key',field.key,'label',field.label,'description',field.description,
             'type',field.type,'icon',field.icon,'required',field.required,'public',field.public,
             'searchable',field.searchable,'filterable',field.filterable,
             'sortable',field.sortable,'sensitive',field.sensitive,
             'offlineCache',field.offline_cache,'defaultValue',field.default_value,
             'validation',field.validation,'options',field.options,'displayOrder',field.display_order
           ) ORDER BY field.display_order,field.id)
           FROM layer_fields field WHERE field.revision_id=revision.id
         ),'[]'::jsonb)
       )::text AS canonical
       FROM layer_revisions revision WHERE revision.id=$1`,
      [revisionId],
    )) as Array<{ canonical: string }>;
    const canonical = rows[0]?.canonical;
    if (!canonical) throw new Error('Publication revision fingerprint source is missing.');
    return this.crypto.checksum(canonical);
  }
}
