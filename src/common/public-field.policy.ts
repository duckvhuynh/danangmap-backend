export const CANONICAL_PUBLIC_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'url',
  'email',
  'phone',
  'enum',
  'multi_enum',
  'address',
] as const;

/**
 * SQL fragment shared by publication hashing and every public serializer.
 * The type rule is deliberately allowlist-first: image/attachment and future
 * field types stay private until they have a canonical safe serializer.
 */
export function canonicalPublicFieldSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) {
    throw new Error('Canonical public field SQL alias is invalid.');
  }
  const types = CANONICAL_PUBLIC_FIELD_TYPES.map((type) => `'${type}'`).join(',');
  return `${alias}.public=true AND ${alias}.sensitive=false AND ${alias}.type=ANY(ARRAY[${types}]::text[])`;
}

export function canonicalPublicRenderableFieldSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) {
    throw new Error('Canonical public field SQL alias is invalid.');
  }
  const scalar = canonicalPublicFieldSql(alias);
  return `(${scalar} OR (${alias}.public=true AND ${alias}.sensitive=false AND ${alias}.type IN ('image','attachment')))`;
}
