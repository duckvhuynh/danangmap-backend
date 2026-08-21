import { AppException } from '../common/http/app.exception';

export function revisionEtag(revisionId: string, lockVersion: number): string {
  return `"rev-${revisionId}-v${lockVersion}"`;
}

export function requireRevisionVersion(ifMatch: string | undefined, revisionId: string): number {
  if (!ifMatch) throw new AppException(428, 'ETAG_REQUIRED', 'Thiếu If-Match.');
  const escaped = revisionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^"rev-${escaped}-v(\\d+)"$`).exec(ifMatch);
  if (!match?.[1]) throw new AppException(412, 'ETAG_MISMATCH', 'ETag không hợp lệ.');
  return Number(match[1]);
}

export function requireIdempotencyKey(value: string | undefined): string {
  if (!value) throw new AppException(428, 'IDEMPOTENCY_KEY_REQUIRED', 'Thiếu Idempotency-Key.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppException(400, 'VALIDATION_FAILED', 'Idempotency-Key phải là UUID.');
  }
  return value;
}

export function cursorEncode(value: string | number): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

export function cursorDecode(value: string): number {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded))
    throw new AppException(400, 'VALIDATION_FAILED', 'Cursor không hợp lệ.');
  return Number(decoded);
}
