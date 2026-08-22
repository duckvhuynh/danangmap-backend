import type { PublicationJobView } from './publication.dto';
import type { PublicationJobRow } from './publication-job.repository';

const FAILURE_MESSAGES: Record<string, { userMessage: string; retryable: boolean }> = {
  PUBLICATION_ACTOR_INELIGIBLE: {
    userMessage: 'Quyền công bố của người yêu cầu không còn hợp lệ.',
    retryable: false,
  },
  PUBLICATION_BASE_STALE: {
    userMessage: 'Publication hiện hành đã thay đổi trong lúc xử lý.',
    retryable: false,
  },
  PUBLICATION_BUILD_LIMIT_EXCEEDED: {
    userMessage: 'Revision vượt quá giới hạn xử lý công bố.',
    retryable: false,
  },
  PUBLICATION_INPUT_INVALID: {
    userMessage: 'Revision không còn hợp lệ để công bố.',
    retryable: false,
  },
  PUBLICATION_SEPARATION_OF_DUTIES: {
    userMessage: 'Người yêu cầu không còn đáp ứng nguyên tắc phân tách nhiệm vụ.',
    retryable: false,
  },
  PUBLICATION_DEPENDENCY_UNAVAILABLE: {
    userMessage: 'Dịch vụ công bố đang tạm thời gián đoạn.',
    retryable: true,
  },
  PUBLICATION_RETRY_EXHAUSTED: {
    userMessage: 'Tác vụ công bố không thể hoàn tất sau nhiều lần thử.',
    retryable: false,
  },
};

export function publicationJobEtag(jobId: string, lockVersion: number): string {
  return `"publication-job-${jobId}-v${lockVersion}"`;
}

export function publicationJobView(row: PublicationJobRow): PublicationJobView {
  const failure = row.failureCode
    ? (FAILURE_MESSAGES[row.failureCode] ?? {
        userMessage: 'Tác vụ công bố không thể hoàn tất.',
        retryable: false,
      })
    : null;
  const percent = (() => {
    if (row.status === 'succeeded') return 100;
    if (row.featureTotal === null || row.featureTotal === 0) return null;
    return Math.floor((row.featureProcessed / row.featureTotal) * 100);
  })();
  return {
    id: row.id,
    layerId: row.layerId,
    revisionId: row.revisionId,
    status: row.status,
    phase: row.phase,
    progress: {
      completedUnits: row.featureProcessed,
      totalUnits: row.featureTotal,
      unit: 'features',
      percent,
    },
    attempt: row.attempts,
    result:
      row.resultSnapshotId && row.resultGeneration !== null
        ? { snapshotId: row.resultSnapshotId, generation: row.resultGeneration }
        : null,
    failure:
      row.failureCode && failure
        ? {
            code: row.failureCode,
            userMessage: failure.userMessage,
            requestId: row.failureCorrelationId,
            retryable: failure.retryable,
          }
        : null,
    createdAt: new Date(row.createdAt).toISOString(),
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
