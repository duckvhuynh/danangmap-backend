import { AppException } from '../common/http/app.exception';
import type { ReceiptClaim } from '../common/idempotency/idempotency.service';

export type PublicationReceiptMetadata =
  { variant: 'legacy-sync' } | { variant: 'durable-async'; retryAfter: number };

export interface PublicationExecutionResult<T = unknown> {
  variant: PublicationReceiptMetadata['variant'];
  data: T;
  etag: string | null;
  location: string | null;
  retryAfter: number | null;
  cacheControl: 'private, no-store' | null;
}

export function synchronousPublicationResult<T>(data: T): PublicationExecutionResult<T> {
  return {
    variant: 'legacy-sync',
    data,
    etag: null,
    location: null,
    retryAfter: null,
    cacheControl: null,
  };
}

export function asynchronousPublicationResult<T extends { id: string }>(
  data: T,
  etag: string,
  retryAfter: number,
): PublicationExecutionResult<T> {
  return {
    variant: 'durable-async',
    data,
    etag,
    location: `/api/v1/admin/publication-jobs/${data.id}`,
    retryAfter,
    cacheControl: 'private, no-store',
  };
}

export function publicationReceiptMetadata(
  result: PublicationExecutionResult,
): PublicationReceiptMetadata {
  return result.variant === 'durable-async'
    ? { variant: result.variant, retryAfter: result.retryAfter! }
    : { variant: result.variant };
}

export function replayPublicationReceipt<T>(
  receipt: ReceiptClaim<T, PublicationReceiptMetadata>,
): PublicationExecutionResult<T> {
  if (receipt.pending || !receipt.response) {
    throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
  }
  if (receipt.statusCode !== 202) incompatibleReceipt();

  if (receipt.metadata?.variant === 'durable-async') {
    const data = receipt.response as T & { id?: unknown };
    const retryAfter = receipt.metadata.retryAfter;
    if (
      typeof data.id !== 'string' ||
      !isUuid(data.id) ||
      !receipt.etag ||
      !Number.isInteger(retryAfter) ||
      retryAfter < 1 ||
      retryAfter > 60
    ) {
      incompatibleReceipt();
    }
    return asynchronousPublicationResult(data as T & { id: string }, receipt.etag, retryAfter);
  }

  if (
    (receipt.metadata?.variant === 'legacy-sync' || receipt.metadata === null) &&
    isLegacyResponse(receipt.response)
  ) {
    return synchronousPublicationResult(receipt.response);
  }
  incompatibleReceipt();
}

function isLegacyResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === 'completed' &&
    typeof candidate.snapshotId === 'string' &&
    isUuid(candidate.snapshotId) &&
    typeof candidate.generation === 'number' &&
    Number.isInteger(candidate.generation) &&
    candidate.generation > 0
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function incompatibleReceipt(): never {
  throw new AppException(
    409,
    'IDEMPOTENCY_RESPONSE_INCOMPATIBLE',
    'Không thể phát lại kết quả công bố đã lưu một cách an toàn.',
  );
}
