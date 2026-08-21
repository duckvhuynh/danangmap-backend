import { ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const dateTime: SchemaObject = { type: 'string', format: 'date-time' };
const nullableDateTime: SchemaObject = { ...dateTime, nullable: true };
const nullableString: SchemaObject = { type: 'string', nullable: true };

export const publicationJobSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'layerId',
    'revisionId',
    'status',
    'phase',
    'progress',
    'attempt',
    'result',
    'failure',
    'createdAt',
    'startedAt',
    'finishedAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    layerId: uuid,
    revisionId: uuid,
    status: { type: 'string', enum: ['queued', 'building', 'succeeded', 'failed'] },
    phase: {
      type: 'string',
      enum: ['queued', 'preparing', 'scanning_features', 'switching', 'completed', 'failed'],
    },
    progress: {
      type: 'object',
      additionalProperties: false,
      required: ['completedUnits', 'totalUnits', 'unit', 'percent'],
      properties: {
        completedUnits: { type: 'integer', minimum: 0 },
        totalUnits: { type: 'integer', nullable: true, minimum: 0 },
        unit: { type: 'string', enum: ['features'] },
        percent: { type: 'integer', nullable: true, minimum: 0, maximum: 100 },
      },
    },
    attempt: { type: 'integer', minimum: 0 },
    result: {
      type: 'object',
      nullable: true,
      additionalProperties: false,
      required: ['snapshotId', 'generation'],
      properties: { snapshotId: uuid, generation: { type: 'integer', minimum: 1 } },
    },
    failure: {
      type: 'object',
      nullable: true,
      additionalProperties: false,
      required: ['code', 'userMessage', 'requestId', 'retryable'],
      properties: {
        code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,99}$' },
        userMessage: { type: 'string' },
        requestId: { ...uuid, nullable: true },
        retryable: { type: 'boolean' },
      },
    },
    createdAt: dateTime,
    startedAt: nullableDateTime,
    finishedAt: nullableDateTime,
    updatedAt: dateTime,
  },
};

export const publicationJobPageSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextCursor', 'hasMore', 'limit'],
  properties: {
    items: { type: 'array', items: publicationJobSchema },
    nextCursor: nullableString,
    hasMore: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
};

const legacyPublicationSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['snapshotId', 'generation', 'status'],
  properties: {
    publicationId: uuid,
    snapshotId: uuid,
    generation: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['completed'] },
  },
};

const envelope = (data: SchemaObject): SchemaObject => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data,
    meta: {
      type: 'object',
      required: ['requestId'],
      properties: { requestId: { type: 'string' } },
    },
  },
});

const problemSchema = (codes: string[]): SchemaObject => ({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'code', 'message', 'details', 'requestId', 'timestamp'],
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer' },
    code: { type: 'string', enum: codes },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    requestId: { type: 'string' },
    timestamp: dateTime,
  },
});

const versionHeaders = {
  ETag: { description: 'Opaque version token.', schema: { type: 'string' } },
  'Retry-After': {
    description: 'Suggested polling delay in seconds for a nonterminal job.',
    schema: { type: 'integer', minimum: 1 },
  },
};

export const apiPublishAcceptedResponse = () =>
  ApiResponse({
    status: 202,
    headers: {
      ...versionHeaders,
      Location: {
        description: 'Durable publication job URL when async publication is enabled.',
        schema: { type: 'string' },
      },
    },
    schema: envelope({ oneOf: [legacyPublicationSchema, publicationJobSchema] }),
  });

export const apiPublicationJobResponse = (data: SchemaObject) =>
  ApiResponse({ status: 200, headers: versionHeaders, schema: envelope(data) });

export const apiPublicationNotModifiedResponse = () =>
  ApiResponse({ status: 304, description: 'The publication job representation is unchanged.' });

export const apiPublicationProblemResponse = (status: number, codes: string[]) =>
  ApiResponse({
    status,
    content: { 'application/problem+json': { schema: problemSchema(codes) } },
  });
