import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import {
  attachmentStatusSchema,
  featureAttachmentSchema,
} from '../common/openapi/response-schemas';

export { attachmentStatusSchema, featureAttachmentSchema };

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const dateTime: SchemaObject = { type: 'string', format: 'date-time' };

export const attachmentMetadataSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'fileName',
    'contentType',
    'sizeBytes',
    'sha256',
    'status',
    'ownerId',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    fileName: { type: 'string' },
    contentType: { type: 'string', nullable: true },
    sizeBytes: { type: 'integer', nullable: true },
    sha256: { type: 'string', nullable: true },
    status: attachmentStatusSchema,
    ownerId: uuid,
    rejectionCode: { type: 'string', nullable: true },
    finalizedAt: { ...dateTime, nullable: true },
    scannedAt: { ...dateTime, nullable: true },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};

export const attachmentUploadIntentSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['uploadId', 'attachmentId', 'status', 'file', 'upload'],
  properties: {
    uploadId: uuid,
    attachmentId: uuid,
    status: { type: 'string', enum: ['uploading'] },
    file: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'contentType', 'sizeBytes', 'sha256'],
      properties: {
        name: { type: 'string' },
        contentType: { type: 'string' },
        sizeBytes: { type: 'integer', minimum: 1, maximum: 25 * 1024 * 1024 },
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      },
    },
    upload: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'url', 'headers', 'expiresAt'],
      properties: {
        method: { type: 'string', enum: ['PUT'] },
        url: { type: 'string', format: 'uri' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          required: ['Content-Type'],
        },
        expiresAt: dateTime,
      },
    },
  },
};

export const attachmentDeleteSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status'],
  properties: { id: uuid, status: { type: 'string', enum: ['deleted'] } },
};
