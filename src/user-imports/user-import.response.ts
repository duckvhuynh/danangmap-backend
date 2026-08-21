import {
  MAX_USER_IMPORT_COLUMNS,
  MAX_USER_IMPORT_EXPANDED_BYTES,
  MAX_USER_IMPORT_ROWS,
  MAX_USER_IMPORT_SHEETS,
} from './user-import.parser';
import type { UserImportIssueEntity, UserImportJobEntity } from './user-import.entity';

export function userImportResponse(job: UserImportJobEntity) {
  return {
    id: job.id,
    status: job.status,
    format: job.format,
    file: { name: job.fileName, sizeBytes: job.sizeBytes },
    progress: job.progress,
    counts: job.counts,
    inspection: {
      sheets: job.sheets,
      selectedSheet: job.selectedSheet,
      limits: {
        maxBytes: 5 * 1024 * 1024,
        maxRows: MAX_USER_IMPORT_ROWS,
        maxSheets: MAX_USER_IMPORT_SHEETS,
        maxColumns: MAX_USER_IMPORT_COLUMNS,
        maxExpandedBytes: MAX_USER_IMPORT_EXPANDED_BYTES,
      },
    },
    validRowPolicy: 'invite' as const,
    failureCode: job.failureCode,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function userImportIssueResponse(issue: UserImportIssueEntity) {
  return {
    id: issue.id,
    rowNumber: issue.rowNumber,
    severity: issue.severity,
    code: issue.code,
    field: issue.field,
  };
}
