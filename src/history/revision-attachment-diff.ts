import type { EntityManager } from 'typeorm';

export interface RevisionAttachmentDiffSummary {
  available: true;
  featuresModified: number;
  added: number;
  removed: number;
  reordered: number;
  redactedChangeCount: number;
}

export interface RevisionAttachmentDescriptor {
  id: string;
  fieldKey: string;
  displayOrder: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: string;
}

export interface RevisionAttachmentOrderChange {
  id: string;
  fieldKey: string;
  fileName: string;
  beforeDisplayOrder: number;
  afterDisplayOrder: number;
}

export interface RevisionAttachmentDiffEntry {
  available: true;
  changed: boolean;
  added: RevisionAttachmentDescriptor[];
  removed: RevisionAttachmentDescriptor[];
  reordered: RevisionAttachmentOrderChange[];
  redactedChange: boolean;
}

export interface AttachmentSideRow extends RevisionAttachmentDescriptor {
  side: 'base' | 'current';
  featureId: string;
  safePublic: boolean;
}

const PUBLIC_ATTACHMENT_FIELD_SQL =
  "field.public=true AND field.sensitive=false AND field.type IN ('image','attachment')";

export async function queryRevisionAttachmentDiffSummary(
  manager: EntityManager,
  currentRevisionId: string,
  baseRevisionId: string | null,
): Promise<RevisionAttachmentDiffSummary> {
  const rows = (await manager.query(
    `WITH current_links AS (
       SELECT member.feature_id,link.attachment_id,link.field_key,link.display_order,
              COALESCE(${PUBLIC_ATTACHMENT_FIELD_SQL},false) AS safe_public
       FROM revision_features member
       JOIN feature_version_attachments link ON link.feature_version_id=member.feature_version_id
       LEFT JOIN layer_fields field
         ON field.revision_id=$1 AND field.key=link.field_key
       WHERE member.revision_id=$1
     ), base_links AS (
       SELECT member.feature_id,link.attachment_id,link.field_key,link.display_order,
              COALESCE(${PUBLIC_ATTACHMENT_FIELD_SQL},false) AS safe_public
       FROM revision_features member
       JOIN feature_version_attachments link ON link.feature_version_id=member.feature_version_id
       LEFT JOIN layer_fields field
         ON field.revision_id=$2 AND field.key=link.field_key
       WHERE member.revision_id=$2
     ), compared AS (
       SELECT COALESCE(current_links.feature_id,base_links.feature_id) AS feature_id,
              current_links.attachment_id AS current_id,
              base_links.attachment_id AS base_id,
              current_links.display_order AS current_order,
              base_links.display_order AS base_order,
              COALESCE(current_links.safe_public,false) AS current_safe,
              COALESCE(base_links.safe_public,false) AS base_safe
       FROM current_links
       FULL JOIN base_links USING(feature_id,attachment_id,field_key)
     ), changes AS (
       SELECT *,
              current_id IS NOT NULL AND current_safe
                AND (base_id IS NULL OR NOT base_safe) AS public_added,
              base_id IS NOT NULL AND base_safe
                AND (current_id IS NULL OR NOT current_safe) AS public_removed,
              current_id IS NOT NULL AND base_id IS NOT NULL
                AND current_safe AND base_safe
                AND current_order IS DISTINCT FROM base_order AS public_reordered,
              (current_id IS NULL OR base_id IS NULL
                OR current_order IS DISTINCT FROM base_order)
                AND ((current_id IS NOT NULL AND NOT current_safe)
                  OR (base_id IS NOT NULL AND NOT base_safe)) AS redacted_change
       FROM compared
     )
     SELECT count(DISTINCT feature_id) FILTER (
              WHERE public_added OR public_removed OR public_reordered OR redacted_change
            )::integer AS "featuresModified",
            count(*) FILTER (WHERE public_added)::integer AS added,
            count(*) FILTER (WHERE public_removed)::integer AS removed,
            count(*) FILTER (WHERE public_reordered)::integer AS reordered,
            count(*) FILTER (WHERE redacted_change)::integer AS "redactedChangeCount"
     FROM changes`,
    [currentRevisionId, baseRevisionId],
  )) as Array<{
    featuresModified: number;
    added: number;
    removed: number;
    reordered: number;
    redactedChangeCount: number;
  }>;
  const summary = rows[0];
  return {
    available: true,
    featuresModified: Number(summary?.featuresModified ?? 0),
    added: Number(summary?.added ?? 0),
    removed: Number(summary?.removed ?? 0),
    reordered: Number(summary?.reordered ?? 0),
    redactedChangeCount: Number(summary?.redactedChangeCount ?? 0),
  };
}

export async function queryRevisionAttachmentDiffEntries(
  manager: EntityManager,
  currentRevisionId: string,
  baseRevisionId: string | null,
  featureIds: string[],
): Promise<Map<string, RevisionAttachmentDiffEntry>> {
  const result = new Map<string, RevisionAttachmentDiffEntry>();
  for (const featureId of featureIds) result.set(featureId, emptyAttachmentDiff());
  if (!featureIds.length) return result;

  const rows = (await manager.query(
    `SELECT side.member_side AS side,member.feature_id AS "featureId",
            attachment.id,link.field_key AS "fieldKey",
            link.display_order AS "displayOrder",attachment.file_name AS "fileName",
            COALESCE(attachment.content_type,attachment.declared_content_type) AS "contentType",
            COALESCE(attachment.size_bytes,attachment.declared_size_bytes)::integer AS "sizeBytes",
            attachment.status,
            COALESCE(${PUBLIC_ATTACHMENT_FIELD_SQL},false) AS "safePublic"
     FROM (VALUES ('current'::text,$1::uuid),('base'::text,$2::uuid))
       AS side(member_side,revision_id)
     JOIN revision_features member ON member.revision_id=side.revision_id
     JOIN feature_version_attachments link ON link.feature_version_id=member.feature_version_id
     JOIN attachments attachment ON attachment.id=link.attachment_id
     LEFT JOIN layer_fields field
       ON field.revision_id=side.revision_id AND field.key=link.field_key
     WHERE member.feature_id=ANY($3::uuid[])
     ORDER BY member.feature_id,link.field_key,link.display_order,attachment.id,side.member_side`,
    [currentRevisionId, baseRevisionId, featureIds],
  )) as AttachmentSideRow[];

  const byFeature = new Map<string, AttachmentSideRow[]>();
  for (const row of rows) {
    const featureRows = byFeature.get(row.featureId) ?? [];
    featureRows.push({
      ...row,
      displayOrder: Number(row.displayOrder),
      sizeBytes: Number(row.sizeBytes),
      safePublic: Boolean(row.safePublic),
    });
    byFeature.set(row.featureId, featureRows);
  }
  for (const featureId of featureIds) {
    result.set(featureId, buildAttachmentDiff(byFeature.get(featureId) ?? []));
  }
  return result;
}

export function buildAttachmentDiff(rows: AttachmentSideRow[]): RevisionAttachmentDiffEntry {
  const current = new Map<string, AttachmentSideRow>();
  const base = new Map<string, AttachmentSideRow>();
  for (const row of rows) {
    const key = `${row.id}\u0000${row.fieldKey}`;
    (row.side === 'current' ? current : base).set(key, row);
  }

  const added: RevisionAttachmentDescriptor[] = [];
  const removed: RevisionAttachmentDescriptor[] = [];
  const reordered: RevisionAttachmentOrderChange[] = [];
  let redactedChange = false;
  for (const key of new Set([...current.keys(), ...base.keys()])) {
    const after = current.get(key);
    const before = base.get(key);
    const actualChanged = !after || !before || after.displayOrder !== before.displayOrder;
    if (after?.safePublic && (!before || !before.safePublic)) added.push(descriptor(after));
    if (before?.safePublic && (!after || !after.safePublic)) removed.push(descriptor(before));
    if (after?.safePublic && before?.safePublic && after.displayOrder !== before.displayOrder) {
      reordered.push({
        id: after.id,
        fieldKey: after.fieldKey,
        fileName: after.fileName,
        beforeDisplayOrder: before.displayOrder,
        afterDisplayOrder: after.displayOrder,
      });
    }
    if (actualChanged && ((after && !after.safePublic) || (before && !before.safePublic))) {
      redactedChange = true;
    }
  }

  added.sort(compareDescriptors);
  removed.sort(compareDescriptors);
  reordered.sort(
    (left, right) =>
      left.fieldKey.localeCompare(right.fieldKey) ||
      left.afterDisplayOrder - right.afterDisplayOrder ||
      left.id.localeCompare(right.id),
  );
  return {
    available: true,
    changed: added.length > 0 || removed.length > 0 || reordered.length > 0 || redactedChange,
    added,
    removed,
    reordered,
    redactedChange,
  };
}

function descriptor(row: AttachmentSideRow): RevisionAttachmentDescriptor {
  return {
    id: row.id,
    fieldKey: row.fieldKey,
    displayOrder: row.displayOrder,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
  };
}

function compareDescriptors(
  left: RevisionAttachmentDescriptor,
  right: RevisionAttachmentDescriptor,
): number {
  return (
    left.fieldKey.localeCompare(right.fieldKey) ||
    left.displayOrder - right.displayOrder ||
    left.id.localeCompare(right.id)
  );
}

function emptyAttachmentDiff(): RevisionAttachmentDiffEntry {
  return {
    available: true,
    changed: false,
    added: [],
    removed: [],
    reordered: [],
    redactedChange: false,
  };
}
