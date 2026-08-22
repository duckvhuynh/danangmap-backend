import { ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const dateTime: SchemaObject = { type: 'string', format: 'date-time' };
const nullableUuid: SchemaObject = { ...uuid, nullable: true };
const nullableDateTime: SchemaObject = { ...dateTime, nullable: true };
const nullableString: SchemaObject = { type: 'string', nullable: true };
const bounds: SchemaObject = {
  type: 'array',
  nullable: true,
  minItems: 4,
  maxItems: 4,
  items: { type: 'number' },
};
const revisionStatus: SchemaObject = {
  type: 'string',
  enum: ['draft', 'in_review', 'changes_requested', 'approved', 'publishing', 'published'],
};
const actorRole: SchemaObject = {
  type: 'string',
  nullable: true,
  enum: ['editor', 'reviewer', 'publisher', 'system_admin'],
};
const geometryKind: SchemaObject = {
  type: 'string',
  enum: ['point', 'multipoint', 'line', 'multiline', 'polygon', 'multipolygon', 'circle'],
};

const pageProperties: Record<string, SchemaObject> = {
  nextCursor: nullableString,
  hasMore: { type: 'boolean' },
  limit: { type: 'integer', minimum: 1, maximum: 100 },
};

export const revisionHistoryItemSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'revisionNo',
    'status',
    'title',
    'supersedesRevisionId',
    'createdBy',
    'createdByDisplayName',
    'submittedAt',
    'approvedAt',
    'publishedAt',
    'createdAt',
    'updatedAt',
    'featureCount',
    'participantCount',
    'activeSnapshotId',
    'activeGeneration',
  ],
  properties: {
    id: uuid,
    revisionNo: { type: 'integer', minimum: 1 },
    status: revisionStatus,
    title: { type: 'string' },
    supersedesRevisionId: nullableUuid,
    createdBy: uuid,
    createdByDisplayName: nullableString,
    submittedAt: nullableDateTime,
    approvedAt: nullableDateTime,
    publishedAt: nullableDateTime,
    createdAt: dateTime,
    updatedAt: dateTime,
    featureCount: { type: 'integer', minimum: 0 },
    participantCount: { type: 'integer', minimum: 0 },
    activeSnapshotId: nullableUuid,
    activeGeneration: { type: 'integer', nullable: true, minimum: 1 },
  },
};

export const revisionHistoryPageSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextCursor', 'hasMore', 'limit'],
  properties: {
    items: { type: 'array', items: revisionHistoryItemSchema },
    ...pageProperties,
  },
};

const participantSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'type', 'participatedAt', 'displayName', 'role'],
  properties: {
    userId: uuid,
    type: { type: 'string', enum: ['edit', 'review', 'publish'] },
    participatedAt: dateTime,
    displayName: nullableString,
    role: actorRole,
  },
};

export const workflowEventSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'fromStatus',
    'toStatus',
    'actorId',
    'actorDisplayName',
    'role',
    'reason',
    'occurredAt',
  ],
  properties: {
    id: uuid,
    fromStatus: revisionStatus,
    toStatus: revisionStatus,
    actorId: uuid,
    actorDisplayName: nullableString,
    role: actorRole,
    reason: nullableString,
    occurredAt: dateTime,
  },
};

export const workflowEventPageSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextCursor', 'hasMore', 'limit'],
  properties: {
    items: { type: 'array', items: workflowEventSchema },
    ...pageProperties,
  },
};

const revisionPublicationSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'snapshotId',
    'generation',
    'status',
    'featureCount',
    'publishedAt',
    'rollbackOf',
    'isActive',
  ],
  properties: {
    snapshotId: uuid,
    generation: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['building', 'published', 'failed'] },
    featureCount: { type: 'integer', minimum: 0 },
    publishedAt: nullableDateTime,
    rollbackOf: nullableUuid,
    isActive: { type: 'boolean' },
  },
};

export const revisionHistoryDetailSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['revision', 'validation', 'participants', 'events', 'publications', 'historyLimits'],
  properties: {
    revision: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id',
        'layerId',
        'revisionNo',
        'status',
        'title',
        'description',
        'geometryMode',
        'allowedGeometryKinds',
        'schemaVersion',
        'lockVersion',
        'supersedesRevisionId',
        'createdBy',
        'createdByDisplayName',
        'submittedAt',
        'approvedAt',
        'publishedAt',
        'createdAt',
        'updatedAt',
        'successorRevisionId',
      ],
      properties: {
        id: uuid,
        layerId: uuid,
        revisionNo: { type: 'integer', minimum: 1 },
        status: revisionStatus,
        title: { type: 'string' },
        description: nullableString,
        geometryMode: {
          type: 'string',
          enum: ['point', 'circle', 'polyline', 'polygon', 'mixed'],
        },
        allowedGeometryKinds: { type: 'array', items: geometryKind },
        schemaVersion: { type: 'integer', minimum: 1 },
        lockVersion: { type: 'integer', minimum: 1 },
        supersedesRevisionId: nullableUuid,
        createdBy: uuid,
        createdByDisplayName: nullableString,
        submittedAt: nullableDateTime,
        approvedAt: nullableDateTime,
        publishedAt: nullableDateTime,
        createdAt: dateTime,
        updatedAt: dateTime,
        successorRevisionId: nullableUuid,
      },
    },
    validation: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'featureCount', 'issues'],
      properties: {
        status: { type: 'string', enum: ['valid', 'invalid'] },
        featureCount: { type: 'integer', minimum: 0 },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'count'],
            properties: {
              code: { type: 'string', enum: ['GEOMETRY_INVALID', 'REQUIRED_PROPERTY_MISSING'] },
              count: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
    participants: { type: 'array', items: participantSchema },
    events: { type: 'array', items: workflowEventSchema },
    publications: { type: 'array', items: revisionPublicationSchema },
    historyLimits: {
      type: 'object',
      additionalProperties: false,
      required: ['participants', 'events', 'publications'],
      properties: Object.fromEntries(
        ['participants', 'events', 'publications'].map((key) => [
          key,
          {
            type: 'object',
            additionalProperties: false,
            required: ['returned', 'hasMore', 'limit'],
            properties: {
              returned: { type: 'integer', minimum: 0, maximum: 100 },
              hasMore: { type: 'boolean' },
              limit: { type: 'integer', enum: [100] },
            },
          },
        ]),
      ),
    },
  },
};

const changedKeysSchema: SchemaObject = {
  type: 'array',
  maxItems: 100,
  items: { type: 'string' },
};

const attachmentDiffUnavailableSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['available', 'status', 'reasonCode'],
  properties: {
    available: { type: 'boolean', enum: [false] },
    status: { type: 'string', enum: ['unavailable'] },
    reasonCode: { type: 'string', enum: ['ATTACHMENT_CONTRACT_PENDING'] },
  },
};

export const revisionDiffSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'revisionId',
    'layerId',
    'comparison',
    'baseRevisionId',
    'geometry',
    'properties',
    'attachments',
    'schema',
    'entries',
    'nextCursor',
    'hasMore',
    'limit',
  ],
  properties: {
    revisionId: uuid,
    layerId: uuid,
    comparison: { type: 'string', enum: ['parent', 'active'] },
    baseRevisionId: nullableUuid,
    geometry: {
      type: 'object',
      additionalProperties: false,
      required: ['currentFeatureCount', 'baseFeatureCount', 'added', 'removed', 'modified'],
      properties: {
        currentFeatureCount: { type: 'integer', minimum: 0 },
        baseFeatureCount: { type: 'integer', minimum: 0 },
        added: { type: 'integer', minimum: 0 },
        removed: { type: 'integer', minimum: 0 },
        modified: { type: 'integer', minimum: 0 },
      },
    },
    properties: {
      type: 'object',
      additionalProperties: false,
      required: ['featuresModified', 'publicFieldKeysChanged'],
      properties: {
        featuresModified: { type: 'integer', minimum: 0 },
        publicFieldKeysChanged: changedKeysSchema,
      },
    },
    attachments: attachmentDiffUnavailableSchema,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'publicFieldsAdded',
        'publicFieldsRemoved',
        'publicFieldsChanged',
        'redactedChangeCount',
      ],
      properties: {
        publicFieldsAdded: changedKeysSchema,
        publicFieldsRemoved: changedKeysSchema,
        publicFieldsChanged: changedKeysSchema,
        redactedChangeCount: { type: 'integer', minimum: 0 },
      },
    },
    entries: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'featureId',
          'changeType',
          'geometry',
          'properties',
          'attachments',
          'redactedChange',
        ],
        properties: {
          featureId: uuid,
          changeType: { type: 'string', enum: ['added', 'removed', 'modified'] },
          geometry: {
            type: 'object',
            additionalProperties: false,
            required: [
              'changed',
              'beforeKind',
              'afterKind',
              'beforeRadiusM',
              'afterRadiusM',
              'beforePreview',
              'afterPreview',
              'beforePreviewMode',
              'afterPreviewMode',
              'beforeBounds',
              'afterBounds',
            ],
            properties: {
              changed: { type: 'boolean' },
              beforeKind: { ...geometryKind, nullable: true },
              afterKind: { ...geometryKind, nullable: true },
              beforeRadiusM: { type: 'number', nullable: true, minimum: 0, exclusiveMinimum: true },
              afterRadiusM: { type: 'number', nullable: true, minimum: 0, exclusiveMinimum: true },
              beforePreview: { type: 'object', nullable: true, additionalProperties: true },
              afterPreview: { type: 'object', nullable: true, additionalProperties: true },
              beforePreviewMode: { type: 'string', nullable: true, enum: ['exact', 'bbox'] },
              afterPreviewMode: { type: 'string', nullable: true, enum: ['exact', 'bbox'] },
              beforeBounds: bounds,
              afterBounds: bounds,
            },
          },
          properties: {
            type: 'object',
            additionalProperties: false,
            required: ['before', 'after', 'changedKeys'],
            properties: {
              before: { type: 'object', additionalProperties: true },
              after: { type: 'object', additionalProperties: true },
              changedKeys: changedKeysSchema,
            },
          },
          attachments: attachmentDiffUnavailableSchema,
          redactedChange: { type: 'boolean' },
        },
      },
    },
    nextCursor: nullableString,
    hasMore: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 25 },
  },
};

const rollbackEligibilitySchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['eligible', 'reasonCode'],
  properties: {
    eligible: { type: 'boolean' },
    reasonCode: {
      type: 'string',
      nullable: true,
      enum: [
        'ROLE_FORBIDDEN',
        'ROLLBACK_TARGET_ACTIVE',
        'SEPARATION_OF_DUTIES',
        'ROLLBACK_TARGET_INVALID',
      ],
    },
  },
};

export const publicationHistoryItemSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'snapshotId',
    'layerId',
    'revisionId',
    'revisionNo',
    'status',
    'generation',
    'progress',
    'featureCount',
    'bounds',
    'checksum',
    'rollbackOf',
    'publishedBy',
    'publishedByDisplayName',
    'publishedAt',
    'activatedAt',
    'createdAt',
    'isActive',
    'rollbackEligibility',
  ],
  properties: {
    snapshotId: uuid,
    layerId: uuid,
    revisionId: uuid,
    revisionNo: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['building', 'published', 'failed'] },
    generation: { type: 'integer', minimum: 1 },
    progress: { type: 'integer', nullable: true, minimum: 0, maximum: 100 },
    featureCount: { type: 'integer', minimum: 0 },
    bounds,
    checksum: { type: 'string' },
    rollbackOf: nullableUuid,
    publishedBy: uuid,
    publishedByDisplayName: nullableString,
    publishedAt: nullableDateTime,
    activatedAt: nullableDateTime,
    createdAt: dateTime,
    isActive: { type: 'boolean' },
    rollbackEligibility: rollbackEligibilitySchema,
  },
};

export const publicationHistoryPageSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'activePointerEtag', 'nextCursor', 'hasMore', 'limit'],
  properties: {
    items: { type: 'array', items: publicationHistoryItemSchema },
    activePointerEtag: nullableString,
    ...pageProperties,
  },
};

export const publicationHistoryDetailSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['publication', 'activePointerEtag'],
  properties: {
    publication: publicationHistoryItemSchema,
    activePointerEtag: nullableString,
  },
};

export const auditHistoryItemSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'actorId',
    'actorRole',
    'actorDisplayName',
    'action',
    'resourceType',
    'resourceId',
    'requestId',
    'beforeDigest',
    'afterDigest',
    'metadata',
    'occurredAt',
  ],
  properties: {
    id: uuid,
    actorId: nullableUuid,
    actorRole,
    actorDisplayName: nullableString,
    action: { type: 'string' },
    resourceType: { type: 'string' },
    resourceId: nullableUuid,
    requestId: uuid,
    beforeDigest: nullableString,
    afterDigest: nullableString,
    metadata: { type: 'object', additionalProperties: true },
    occurredAt: dateTime,
  },
};

export const auditHistoryPageSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextCursor', 'hasMore', 'limit'],
  properties: {
    items: { type: 'array', items: auditHistoryItemSchema },
    ...pageProperties,
  },
};

export const rollbackPublicationResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'publicationId',
    'snapshotId',
    'targetSnapshotId',
    'generation',
    'status',
    'activeRevisionId',
  ],
  properties: {
    publicationId: uuid,
    snapshotId: uuid,
    targetSnapshotId: uuid,
    generation: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['completed'] },
    activeRevisionId: uuid,
  },
};

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

export const apiHistoryProblemResponse = (status: number, codes: string[]) =>
  ApiResponse({
    status,
    content: { 'application/problem+json': { schema: problemSchema(codes) } },
  });
