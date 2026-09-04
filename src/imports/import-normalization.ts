const FORBIDDEN_COLUMN_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_COLUMN_NAME = /^[\p{L}\p{M}\p{N}_. -]{1,200}$/u;
const EXPLICIT_URI_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

export function normalizeImportColumnName(value: string): string {
  return value.normalize('NFC').trim();
}

export function isSafeImportColumnName(value: string): boolean {
  const normalized = normalizeImportColumnName(value);
  return SAFE_COLUMN_NAME.test(normalized) && !FORBIDDEN_COLUMN_NAMES.has(normalized.toLowerCase());
}

export function normalizeImportedFieldValue(
  value: unknown,
  fieldType: string | undefined,
  fieldKey?: string,
): unknown {
  const normalizedFieldKey = fieldKey?.trim().toLowerCase();
  const isWebsiteField =
    fieldType === 'url' ||
    normalizedFieldKey === 'url' ||
    normalizedFieldKey === 'website' ||
    normalizedFieldKey?.endsWith('_url') === true ||
    normalizedFieldKey?.endsWith('-url') === true;
  if (!isWebsiteField || typeof value !== 'string') return value;
  const normalized = value.trim();
  if (!normalized) return normalized;
  if (/^https?:\/\//iu.test(normalized) || EXPLICIT_URI_SCHEME.test(normalized)) {
    return normalized;
  }
  if (normalized.startsWith('//')) return `https:${normalized}`;
  return `https://${normalized}`;
}
