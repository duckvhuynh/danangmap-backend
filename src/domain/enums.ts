export const USER_ROLES = ['system_admin', 'editor', 'reviewer', 'publisher'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'inactive', 'disabled', 'invited'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const REVISION_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'publishing',
  'published',
] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const GEOMETRY_MODES = ['point', 'circle', 'polyline', 'polygon', 'mixed'] as const;
export type GeometryMode = (typeof GEOMETRY_MODES)[number];

export const GEOMETRY_KINDS = [
  'point',
  'multipoint',
  'line',
  'multiline',
  'polygon',
  'multipolygon',
  'circle',
] as const;
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

export const IMPORT_FORMATS = ['csv', 'xlsx', 'geojson', 'kml'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const IMPORT_MODES = ['append', 'replace', 'upsert'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];
