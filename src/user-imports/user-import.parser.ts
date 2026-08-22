import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { isEmail } from 'class-validator';
import type { UserRole } from '../domain/enums';
import { USER_ROLES } from '../domain/enums';
import type { UserImportFormat } from './user-import.entity';
import { MAX_USER_IMPORT_BYTES } from './user-import-upload.guard';

export const MAX_USER_IMPORT_ROWS = 5_000;
export const MAX_USER_IMPORT_SHEETS = 10;
export const MAX_USER_IMPORT_COLUMNS = 4;
export const MAX_USER_IMPORT_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const HEADERS = ['email', 'username', 'displayName', 'role'] as const;
const FORBIDDEN_HEADER = /(?:password|passphrase|mfa|totp|otp|recovery|secret|credential)/i;

export type UserImportFailureCode =
  | 'USER_IMPORT_FILE_INVALID'
  | 'USER_IMPORT_FORMAT_UNSUPPORTED'
  | 'USER_IMPORT_FORMAT_MISMATCH'
  | 'USER_IMPORT_CSV_INVALID'
  | 'USER_IMPORT_XLSX_INVALID'
  | 'USER_IMPORT_XLSX_UNSAFE'
  | 'USER_IMPORT_XLSX_FORMULA_FORBIDDEN'
  | 'USER_IMPORT_EXPANDED_SIZE_LIMIT'
  | 'USER_IMPORT_SHEET_LIMIT'
  | 'USER_IMPORT_SHEET_NOT_FOUND'
  | 'USER_IMPORT_SHEET_REQUIRED'
  | 'USER_IMPORT_COLUMN_LIMIT'
  | 'USER_IMPORT_COLUMNS_INVALID'
  | 'USER_IMPORT_FORBIDDEN_COLUMN'
  | 'USER_IMPORT_ROW_LIMIT';

export class UserImportParserError extends Error {
  constructor(readonly code: UserImportFailureCode) {
    super(code);
  }
}

export interface UserImportSourceRow {
  rowNumber: number;
  email: unknown;
  username: unknown;
  displayName: unknown;
  role: unknown;
}

export interface NormalizedUserImportRow {
  rowNumber: number;
  email: string;
  emailNormalized: string;
  username: string;
  usernameNormalized: string;
  displayName: string;
  role: UserRole | '';
}

export interface UserImportRowIssue {
  rowNumber: number;
  severity: 'error';
  code: string;
  field: 'email' | 'username' | 'displayName' | 'role' | null;
}

export interface UserImportInspection {
  format: UserImportFormat;
  sheets: string[];
  headers: string[];
}

export function detectUserImport(
  file: Pick<Express.Multer.File, 'buffer' | 'originalname' | 'size'>,
): UserImportFormat {
  if (file.size < 1 || file.size > MAX_USER_IMPORT_BYTES || file.buffer.byteLength !== file.size) {
    throw new UserImportParserError('USER_IMPORT_FILE_INVALID');
  }
  const name = file.originalname.toLowerCase();
  const zip = file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
  if (name.endsWith('.xlsx') && zip) return 'xlsx';
  if (name.endsWith('.csv') && !file.buffer.subarray(0, 65_536).includes(0)) return 'csv';
  if (name.endsWith('.xlsx') || name.endsWith('.csv')) {
    throw new UserImportParserError('USER_IMPORT_FORMAT_MISMATCH');
  }
  throw new UserImportParserError('USER_IMPORT_FORMAT_UNSUPPORTED');
}

export async function inspectUserImport(
  content: Buffer,
  format: UserImportFormat,
): Promise<UserImportInspection> {
  if (format === 'csv') {
    const rows = parseCsvArrays(content, 1);
    const headers = validateHeaders(rows[0] ?? []);
    return { format, sheets: [], headers };
  }
  const workbook = await loadSafeWorkbook(content);
  const sheets = workbook.worksheets.map((sheet) => sheet.name);
  const first = workbook.worksheets[0];
  if (!first) throw new UserImportParserError('USER_IMPORT_XLSX_INVALID');
  const headers = sheets.length === 1 ? validateHeaders(rowValues(first.getRow(1), true)) : [];
  return { format, sheets, headers };
}

export async function parseUserImport(
  content: Buffer,
  format: UserImportFormat,
  selectedSheet: string | null,
): Promise<UserImportSourceRow[]> {
  if (format === 'csv') {
    const rows = parseCsvArrays(content, MAX_USER_IMPORT_ROWS + 2);
    validateHeaders(rows[0] ?? []);
    if (rows.length - 1 > MAX_USER_IMPORT_ROWS) {
      throw new UserImportParserError('USER_IMPORT_ROW_LIMIT');
    }
    return rows.slice(1).map((values, index) => sourceRow(index + 2, values));
  }

  const workbook = await loadSafeWorkbook(content);
  if (workbook.worksheets.length > 1 && !selectedSheet) {
    throw new UserImportParserError('USER_IMPORT_SHEET_REQUIRED');
  }
  const worksheet = selectedSheet ? workbook.getWorksheet(selectedSheet) : workbook.worksheets[0];
  if (!worksheet) throw new UserImportParserError('USER_IMPORT_SHEET_NOT_FOUND');
  validateHeaders(rowValues(worksheet.getRow(1), true));
  if (worksheet.actualRowCount - 1 > MAX_USER_IMPORT_ROWS) {
    throw new UserImportParserError('USER_IMPORT_ROW_LIMIT');
  }
  const rows: UserImportSourceRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = rowValues(row, false);
    if (values.every((value) => value === null || value === '')) return;
    rows.push(sourceRow(rowNumber, values));
  });
  if (rows.length > MAX_USER_IMPORT_ROWS) {
    throw new UserImportParserError('USER_IMPORT_ROW_LIMIT');
  }
  return rows;
}

export function normalizeUserImportRow(source: UserImportSourceRow): {
  row: NormalizedUserImportRow;
  issues: UserImportRowIssue[];
} {
  const stringValue = (value: unknown) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : '';
  const email = stringValue(source.email);
  const emailNormalized = email.toLowerCase();
  const username = stringValue(source.username);
  const usernameNormalized = username.toLowerCase();
  const displayName = stringValue(source.displayName);
  const roleValue = stringValue(source.role).toLowerCase();
  const role = USER_ROLES.includes(roleValue as UserRole) ? (roleValue as UserRole) : '';
  const issues: UserImportRowIssue[] = [];
  if (email.length > 254 || !isEmail(email, { allow_utf8_local_part: false })) {
    issues.push(issue(source.rowNumber, 'USER_IMPORT_EMAIL_INVALID', 'email'));
  }
  if (!/^[a-z][a-z0-9._-]{2,63}$/.test(usernameNormalized) || username !== usernameNormalized) {
    issues.push(issue(source.rowNumber, 'USER_IMPORT_USERNAME_INVALID', 'username'));
  }
  if (displayName.length < 2 || displayName.length > 200) {
    issues.push(issue(source.rowNumber, 'USER_IMPORT_DISPLAY_NAME_INVALID', 'displayName'));
  }
  if (!role) issues.push(issue(source.rowNumber, 'USER_IMPORT_ROLE_INVALID', 'role'));
  return {
    row: {
      rowNumber: source.rowNumber,
      email,
      emailNormalized,
      username,
      usernameNormalized,
      displayName,
      role,
    },
    issues,
  };
}

function parseCsvArrays(content: Buffer, maxRows: number): unknown[][] {
  try {
    return parseCsv(content, {
      bom: true,
      columns: false,
      encoding: 'utf8',
      max_record_size: 8 * 1024,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
      to: maxRows,
    }) as unknown[][];
  } catch (error) {
    if (error instanceof UserImportParserError) throw error;
    throw new UserImportParserError('USER_IMPORT_CSV_INVALID');
  }
}

async function loadSafeWorkbook(content: Buffer): Promise<ExcelJS.Workbook> {
  enforceSafeXlsxPackage(content);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(content).buffer, {
      ignoreNodes: ['dataValidations', 'hyperlinks'],
    });
  } catch (error) {
    if (error instanceof UserImportParserError) throw error;
    throw new UserImportParserError('USER_IMPORT_XLSX_INVALID');
  }
  if (workbook.worksheets.length < 1) throw new UserImportParserError('USER_IMPORT_XLSX_INVALID');
  if (workbook.worksheets.length > MAX_USER_IMPORT_SHEETS) {
    throw new UserImportParserError('USER_IMPORT_SHEET_LIMIT');
  }
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        if (value && typeof value === 'object' && 'formula' in value) {
          throw new UserImportParserError('USER_IMPORT_XLSX_FORMULA_FORBIDDEN');
        }
      });
    });
  }
  return workbook;
}

function enforceSafeXlsxPackage(content: Buffer): void {
  let offset = 0;
  let entries = 0;
  let expandedBytes = 0;
  while (offset + 46 <= content.byteLength) {
    if (content.readUInt32LE(offset) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const uncompressed = content.readUInt32LE(offset + 24);
    if (uncompressed === 0xffffffff) {
      throw new UserImportParserError('USER_IMPORT_XLSX_UNSAFE');
    }
    expandedBytes += uncompressed;
    if (expandedBytes > MAX_USER_IMPORT_EXPANDED_BYTES) {
      throw new UserImportParserError('USER_IMPORT_EXPANDED_SIZE_LIMIT');
    }
    const nameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const name = content
      .subarray(nameStart, nameStart + nameLength)
      .toString('utf8')
      .toLowerCase();
    if (
      name.includes('vbaproject') ||
      name.startsWith('xl/externallinks/') ||
      name.includes('activex') ||
      name.includes('embeddings/')
    ) {
      throw new UserImportParserError('USER_IMPORT_XLSX_UNSAFE');
    }
    entries += 1;
    if (entries > MAX_ZIP_ENTRIES) {
      throw new UserImportParserError('USER_IMPORT_XLSX_UNSAFE');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries === 0) throw new UserImportParserError('USER_IMPORT_XLSX_INVALID');
}

function validateHeaders(values: unknown[]): string[] {
  if (values.length > MAX_USER_IMPORT_COLUMNS) {
    throw new UserImportParserError('USER_IMPORT_COLUMN_LIMIT');
  }
  const headers = values.map((value) => (typeof value === 'string' ? value.trim() : ''));
  if (headers.some((header) => FORBIDDEN_HEADER.test(header))) {
    throw new UserImportParserError('USER_IMPORT_FORBIDDEN_COLUMN');
  }
  if (
    headers.length !== HEADERS.length ||
    new Set(headers).size !== HEADERS.length ||
    HEADERS.some((header, index) => headers[index] !== header)
  ) {
    throw new UserImportParserError('USER_IMPORT_COLUMNS_INVALID');
  }
  return headers;
}

function rowValues(row: ExcelJS.Row, headers: boolean): unknown[] {
  const values: unknown[] = [];
  for (let index = 1; index <= Math.max(row.cellCount, MAX_USER_IMPORT_COLUMNS); index += 1) {
    const value = row.getCell(index).value;
    if (value && typeof value === 'object' && 'formula' in value) {
      throw new UserImportParserError('USER_IMPORT_XLSX_FORMULA_FORBIDDEN');
    }
    if (value && typeof value === 'object' && 'richText' in value) {
      values.push((value.richText as Array<{ text: string }>).map((part) => part.text).join(''));
    } else {
      values.push(value ?? '');
    }
  }
  while (values.length && values.at(-1) === '') values.pop();
  if (!headers && values.length > MAX_USER_IMPORT_COLUMNS) {
    throw new UserImportParserError('USER_IMPORT_COLUMN_LIMIT');
  }
  return values;
}

function sourceRow(rowNumber: number, values: unknown[]): UserImportSourceRow {
  if (values.length > MAX_USER_IMPORT_COLUMNS) {
    throw new UserImportParserError('USER_IMPORT_COLUMN_LIMIT');
  }
  const record = Object.fromEntries(HEADERS.map((header, index) => [header, values[index]]));
  return {
    rowNumber,
    email: record.email,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
  };
}

function issue(
  rowNumber: number,
  code: string,
  field: UserImportRowIssue['field'],
): UserImportRowIssue {
  return { rowNumber, severity: 'error', code, field };
}
