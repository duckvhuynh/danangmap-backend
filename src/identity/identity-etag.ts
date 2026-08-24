import { AppException } from '../common/http/app.exception';

export type IdentityResource = 'user' | 'invite';

export function identityEtag(
  resource: IdentityResource,
  resourceId: string,
  lockVersion: number,
): string {
  return `"${resource}-${resourceId}-v${lockVersion}"`;
}

export function requireIdentityVersion(
  value: string | undefined,
  resource: IdentityResource,
  resourceId: string,
): number {
  if (!value) throw new AppException(428, 'ETAG_REQUIRED', 'Thiếu If-Match.');
  const escaped = resourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^"${resource}-${escaped}-v(\\d+)"$`).exec(value);
  if (!match?.[1]) throw new AppException(412, 'ETAG_MISMATCH', 'ETag không hợp lệ.');
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppException(412, 'ETAG_MISMATCH', 'ETag không hợp lệ.');
  }
  return version;
}
