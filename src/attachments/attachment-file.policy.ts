import { basename, extname } from 'node:path';
import { AppException } from '../common/http/app.exception';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const TYPES_BY_EXTENSION: Record<string, readonly string[]> = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.pdf': ['application/pdf'],
  '.txt': ['text/plain'],
  '.csv': ['text/csv', 'text/plain'],
  '.json': ['application/json'],
  '.geojson': ['application/geo+json', 'application/json'],
  '.kml': ['application/vnd.google-earth.kml+xml', 'application/xml', 'text/xml'],
  '.zip': ['application/zip'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
};

const ZIP_TYPES = new Set([
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const TEXT_TYPES = new Set([
  'text/plain',
  'text/csv',
  'application/json',
  'application/geo+json',
  'application/vnd.google-earth.kml+xml',
  'application/xml',
  'text/xml',
]);

export interface DeclaredAttachmentFile {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export function validateDeclaredAttachment(input: DeclaredAttachmentFile): {
  fileName: string;
  contentType: string;
} {
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new AppException(413, 'RESOURCE_LIMIT_EXCEEDED', 'Tệp đính kèm vượt quá 25 MiB.');
  }
  const fileName = sanitizeFileName(input.fileName);
  const extension = extname(fileName).toLowerCase();
  const contentType = normalizeContentType(input.contentType);
  const allowed = TYPES_BY_EXTENSION[extension];
  if (!allowed?.includes(contentType)) {
    throw new AppException(
      415,
      'ATTACHMENT_TYPE_UNSUPPORTED',
      'Định dạng hoặc MIME của tệp đính kèm không được hỗ trợ.',
    );
  }
  return { fileName, contentType };
}

export function validateAttachmentBytes(buffer: Buffer, contentType: string): void {
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AppException(413, 'RESOURCE_LIMIT_EXCEEDED', 'Kích thước tệp đính kèm không hợp lệ.');
  }
  const matches = (() => {
    if (contentType === 'image/jpeg') return startsWith(buffer, [0xff, 0xd8, 0xff]);
    if (contentType === 'image/png')
      return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (contentType === 'image/gif') {
      const signature = buffer.subarray(0, 6).toString('ascii');
      return signature === 'GIF87a' || signature === 'GIF89a';
    }
    if (contentType === 'image/webp') {
      return (
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    }
    if (contentType === 'application/pdf')
      return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    if (ZIP_TYPES.has(contentType)) return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
    if (TEXT_TYPES.has(contentType)) return validText(buffer, contentType);
    return false;
  })();
  if (!matches) {
    throw new AppException(
      422,
      'ATTACHMENT_MIME_MISMATCH',
      'Nội dung tệp không khớp với định dạng đã khai báo.',
    );
  }
}

export function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function sanitizeFileName(value: string): string {
  const candidate = basename(value.normalize('NFKC'))
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .trim();
  if (!candidate || candidate.length > 255 || candidate === '.' || candidate === '..') {
    throw new AppException(422, 'ATTACHMENT_NAME_INVALID', 'Tên tệp đính kèm không hợp lệ.');
  }
  return candidate;
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function validText(buffer: Buffer, contentType: string): boolean {
  if (buffer.includes(0)) return false;
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  const trimmed = value.trimStart();
  if (contentType === 'application/json' || contentType === 'application/geo+json') {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }
  if (
    ['application/vnd.google-earth.kml+xml', 'application/xml', 'text/xml'].includes(contentType)
  ) {
    return trimmed.startsWith('<?xml') || trimmed.startsWith('<kml') || trimmed.startsWith('<');
  }
  return true;
}
