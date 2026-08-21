import { ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const dateTime: SchemaObject = { type: 'string', format: 'date-time' };
const nullableString: SchemaObject = { type: 'string', nullable: true };
const jsonObject: SchemaObject = { type: 'object', additionalProperties: true };

export const requestMetaSchema: SchemaObject = {
  type: 'object',
  required: ['requestId'],
  properties: { requestId: { type: 'string' } },
};

export const envelopeSchema = (
  data: SchemaObject,
  meta: SchemaObject = requestMetaSchema,
): SchemaObject => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: { data, meta },
});

export const apiJsonResponse = (status: number, data: SchemaObject, meta?: SchemaObject) =>
  ApiResponse({ status, schema: envelopeSchema(data, meta) });

export const apiRawJsonResponse = (status: number, schema: SchemaObject) =>
  ApiResponse({ status, content: { 'application/json': { schema } } });

export const apiBinaryResponse = (status: number, mediaType: string) =>
  ApiResponse({
    status,
    content: { [mediaType]: { schema: { type: 'string', format: 'binary' } } },
  });

export const genericObjectSchema = jsonObject;

export const authPrincipalSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'email',
    'username',
    'displayName',
    'role',
    'status',
    'mfaEnabled',
    'mustChangePassword',
  ],
  properties: {
    id: uuid,
    email: { type: 'string', format: 'email' },
    username: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: ['editor', 'reviewer', 'publisher', 'system_admin'] },
    status: { type: 'string', enum: ['active', 'inactive', 'disabled', 'invited'] },
    mfaEnabled: { type: 'boolean' },
    mustChangePassword: { type: 'boolean' },
  },
};

export const inviteResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'email', 'role', 'status', 'expiresAt'],
  properties: {
    id: uuid,
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['editor', 'reviewer', 'publisher', 'system_admin'] },
    status: { type: 'string', enum: ['pending'] },
    expiresAt: dateTime,
  },
};

export const inviteInspectionSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['maskedEmail', 'role', 'expiresAt', 'requiresMfaEnrollment'],
  properties: {
    maskedEmail: { type: 'string' },
    role: { type: 'string', enum: ['editor', 'reviewer', 'publisher', 'system_admin'] },
    expiresAt: dateTime,
    requiresMfaEnrollment: { type: 'boolean', enum: [true] },
  },
};

export const inviteRevocationSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status', 'revokedAt'],
  properties: {
    id: uuid,
    status: { type: 'string', enum: ['revoked'] },
    revokedAt: dateTime,
  },
};

export const userCreationResultSchema: SchemaObject = {
  oneOf: [authPrincipalSchema, inviteResultSchema],
};

export const userListMetaSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['requestId', 'nextCursor', 'hasMore', 'limit'],
  properties: {
    requestId: { type: 'string' },
    nextCursor: nullableString,
    hasMore: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
};

export const loginResultSchema: SchemaObject = {
  type: 'object',
  required: ['status', 'mfaEnrollmentRequired', 'challengeExpiresAt'],
  properties: {
    status: { type: 'string', enum: ['mfa_required'] },
    mfaEnrollmentRequired: { type: 'boolean' },
    challengeExpiresAt: dateTime,
  },
};

export const csrfResultSchema: SchemaObject = {
  type: 'object',
  required: ['csrfToken'],
  properties: { csrfToken: { type: 'string' } },
};

export const mfaEnrollmentSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'enrollmentUri'],
  properties: {
    status: { type: 'string', enum: ['pending'] },
    enrollmentUri: { type: 'string', pattern: '^otpauth://totp/' },
  },
};

export const mfaEnrollmentConfirmationSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['principal', 'recoveryCodes'],
  properties: {
    principal: authPrincipalSchema,
    recoveryCodes: {
      type: 'array',
      minItems: 10,
      maxItems: 10,
      items: { type: 'string', pattern: '^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$' },
    },
  },
};

export const logoutResultSchema: SchemaObject = {
  type: 'object',
  required: ['status', 'recoveryAction'],
  properties: {
    status: { type: 'string', enum: ['logged_out'] },
    recoveryAction: { type: 'string', enum: ['delete'] },
  },
};

export const passwordChangeResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'sessionsRevoked', 'sessionRotated', 'principal'],
  properties: {
    status: { type: 'string', enum: ['password_changed'] },
    sessionsRevoked: { type: 'integer', minimum: 1 },
    sessionRotated: { type: 'boolean', enum: [true] },
    principal: authPrincipalSchema,
  },
};

export const passwordResetRequestResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['accepted'] },
  },
};

export const passwordResetConfirmationSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'loginRequired', 'sessionsRevoked'],
  properties: {
    status: { type: 'string', enum: ['password_reset'] },
    loginRequired: { type: 'boolean', enum: [true] },
    sessionsRevoked: { type: 'integer', minimum: 0 },
  },
};

export const sessionRevocationResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'revokedCount', 'currentSessionRevoked', 'loginRequired'],
  properties: {
    status: { type: 'string', enum: ['sessions_revoked'] },
    revokedCount: { type: 'integer', minimum: 1 },
    currentSessionRevoked: { type: 'boolean', enum: [true] },
    loginRequired: { type: 'boolean', enum: [true] },
  },
};

const layerGroupSchema: SchemaObject = {
  type: 'object',
  nullable: true,
  required: ['id', 'slug', 'title', 'displayOrder'],
  properties: {
    id: uuid,
    slug: { type: 'string' },
    title: { type: 'string' },
    displayOrder: { type: 'integer' },
  },
};

export const publicLayerSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'slug',
    'group',
    'displayOrder',
    'title',
    'geometryMode',
    'allowedGeometryKinds',
    'snapshotId',
    'revisionId',
    'generation',
    'featureCount',
    'sourceKind',
    'geoJsonUrl',
    'tileUrlTemplate',
    'sourceLayer',
    'minZoom',
    'maxZoom',
    'cluster',
    'style',
    'popupConfig',
    'filterCapabilities',
    'searchCapabilities',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    slug: { type: 'string' },
    group: layerGroupSchema,
    displayOrder: { type: 'integer' },
    title: { type: 'string' },
    description: nullableString,
    geometryMode: { type: 'string', enum: ['point', 'circle', 'polyline', 'polygon', 'mixed'] },
    allowedGeometryKinds: { type: 'array', items: { type: 'string' } },
    snapshotId: uuid,
    revisionId: uuid,
    generation: { type: 'integer' },
    featureCount: { type: 'integer', minimum: 0 },
    bounds: {
      type: 'array',
      nullable: true,
      minItems: 4,
      maxItems: 4,
      items: { type: 'number' },
    },
    sourceKind: { type: 'string', enum: ['geojson', 'mvt', 'hybrid'] },
    geoJsonUrl: { type: 'string' },
    tileUrlTemplate: { type: 'string' },
    sourceLayer: { type: 'string' },
    minZoom: { type: 'number' },
    maxZoom: { type: 'number' },
    cluster: { type: 'boolean' },
    style: jsonObject,
    popupConfig: jsonObject,
    filterCapabilities: {
      type: 'object',
      required: ['fieldKeys', 'maxFilters'],
      properties: {
        fieldKeys: { type: 'array', items: { type: 'string' } },
        maxFilters: { type: 'integer' },
      },
    },
    searchCapabilities: {
      type: 'object',
      required: ['enabled', 'fieldKeys'],
      properties: {
        enabled: { type: 'boolean' },
        fieldKeys: { type: 'array', items: { type: 'string' } },
      },
    },
    updatedAt: dateTime,
  },
};

export const publicLayerDetailSchema: SchemaObject = {
  ...publicLayerSchema,
  required: [...(publicLayerSchema.required ?? []), 'fields'],
  properties: {
    ...publicLayerSchema.properties,
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'key', 'label', 'type', 'required', 'searchable', 'filterable'],
        properties: {
          id: uuid,
          key: { type: 'string' },
          label: { type: 'string' },
          description: nullableString,
          type: { type: 'string' },
          icon: nullableString,
          required: { type: 'boolean' },
          searchable: { type: 'boolean' },
          filterable: { type: 'boolean' },
          sortable: { type: 'boolean' },
          defaultValue: {},
          validation: jsonObject,
          options: { type: 'array', items: {} },
          displayOrder: { type: 'integer' },
        },
      },
    },
  },
};

const geoJsonGeometrySchema: SchemaObject = {
  type: 'object',
  required: ['type'],
  additionalProperties: true,
  properties: { type: { type: 'string' } },
};

export const publicGeoJsonFeatureSchema: SchemaObject = {
  type: 'object',
  required: ['type', 'id', 'geometry', 'properties'],
  properties: {
    type: { type: 'string', enum: ['Feature'] },
    id: uuid,
    geometry: geoJsonGeometrySchema,
    properties: jsonObject,
    geometryKind: { type: 'string' },
    radiusM: { type: 'number', nullable: true },
  },
};

export const publicFeatureCollectionSchema: SchemaObject = {
  type: 'object',
  required: ['type', 'features', 'meta'],
  properties: {
    type: { type: 'string', enum: ['FeatureCollection'] },
    features: { type: 'array', items: publicGeoJsonFeatureSchema },
    meta: {
      type: 'object',
      required: ['layerSlug', 'generation', 'returned', 'truncated', 'nextCursor'],
      properties: {
        layerSlug: { type: 'string' },
        generation: { type: 'integer' },
        returned: { type: 'integer', minimum: 0 },
        truncated: { type: 'boolean' },
        nextCursor: nullableString,
      },
    },
  },
};

export const publicFeatureDetailSchema: SchemaObject = {
  type: 'object',
  required: ['type', 'id', 'geometry', 'properties', 'attachments', 'meta'],
  properties: {
    ...publicGeoJsonFeatureSchema.properties,
    attachments: { type: 'array', items: jsonObject },
    meta: {
      type: 'object',
      required: ['layerSlug', 'snapshotId', 'generation', 'geometryKind', 'radiusM'],
      properties: {
        layerSlug: { type: 'string' },
        snapshotId: uuid,
        generation: { type: 'integer' },
        geometryKind: { type: 'string' },
        radiusM: { type: 'number', nullable: true },
      },
    },
  },
};

const positionSchema: SchemaObject = {
  type: 'object',
  nullable: true,
  required: ['longitude', 'latitude'],
  properties: { longitude: { type: 'number' }, latitude: { type: 'number' } },
};

export const publicSearchItemSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'source',
    'kind',
    'title',
    'position',
    'layer',
    'featureId',
    'providerPlaceId',
    'score',
    'highlights',
  ],
  properties: {
    id: { type: 'string' },
    source: { type: 'string', enum: ['internal', 'geo_service'] },
    kind: { type: 'string', enum: ['feature', 'place'] },
    title: { type: 'string' },
    subtitle: nullableString,
    position: { ...positionSchema },
    bbox: {
      type: 'array',
      nullable: true,
      minItems: 4,
      maxItems: 4,
      items: { type: 'number' },
    },
    layer: { ...jsonObject, nullable: true },
    featureId: { ...uuid, nullable: true },
    providerPlaceId: nullableString,
    score: { type: 'number' },
    highlights: { type: 'array', items: { type: 'string' } },
  },
};

export const publicSearchMetaSchema: SchemaObject = {
  type: 'object',
  required: ['partial', 'sources', 'warnings', 'nextCursor', 'requestId'],
  properties: {
    partial: { type: 'boolean' },
    sources: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['status', 'count'],
        properties: {
          status: { type: 'string', enum: ['ok', 'skipped', 'unavailable'] },
          count: { type: 'integer', minimum: 0 },
        },
      },
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
    },
    nextCursor: nullableString,
    requestId: { type: 'string' },
  },
};

export const externalPlaceSchema: SchemaObject = {
  type: 'object',
  required: ['id', 'name', 'position', 'source'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    address: nullableString,
    position: { ...positionSchema },
    phone: nullableString,
    website: nullableString,
    source: { type: 'string', enum: ['geo_service'] },
  },
};

export const adminLayerGroupSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'title', 'displayOrder', 'defaultVisible'],
  properties: {
    id: uuid,
    slug: { type: 'string' },
    title: { type: 'string' },
    description: nullableString,
    displayOrder: { type: 'integer' },
    defaultVisible: { type: 'boolean' },
    archivedAt: { ...dateTime, nullable: true },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};

export const adminLayerListItemSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'displayOrder'],
  properties: {
    id: uuid,
    slug: { type: 'string' },
    groupId: { ...uuid, nullable: true },
    displayOrder: { type: 'integer' },
    archivedAt: { ...dateTime, nullable: true },
    revisionId: { ...uuid, nullable: true },
    title: { ...nullableString },
    status: { ...nullableString },
    geometryMode: { ...nullableString },
    updatedAt: { ...dateTime, nullable: true },
  },
};

export const adminLayerEntitySchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'groupId', 'displayOrder', 'createdBy', 'archivedAt'],
  properties: {
    id: uuid,
    slug: { type: 'string' },
    groupId: { ...uuid, nullable: true },
    displayOrder: { type: 'integer' },
    createdBy: uuid,
    archivedAt: { ...dateTime, nullable: true },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};

export const adminRevisionSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'layerId',
    'revisionNo',
    'status',
    'title',
    'geometryMode',
    'allowedGeometryKinds',
    'style',
    'renderConfig',
    'popupConfig',
    'schemaVersion',
    'lockVersion',
    'cursorSeq',
    'createdBy',
  ],
  properties: {
    id: uuid,
    layerId: uuid,
    revisionNo: { type: 'integer' },
    status: { type: 'string' },
    title: { type: 'string' },
    description: nullableString,
    geometryMode: { type: 'string', enum: ['point', 'circle', 'polyline', 'polygon', 'mixed'] },
    allowedGeometryKinds: { type: 'array', items: { type: 'string' } },
    style: jsonObject,
    renderConfig: jsonObject,
    popupConfig: jsonObject,
    schemaVersion: { type: 'integer' },
    lockVersion: { type: 'integer' },
    cursorSeq: { type: 'string' },
    createdBy: uuid,
    supersedesRevisionId: { ...uuid, nullable: true },
    submittedAt: { ...dateTime, nullable: true },
    approvedAt: { ...dateTime, nullable: true },
    publishedAt: { ...dateTime, nullable: true },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};

export const adminLayerFieldSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'revisionId',
    'key',
    'label',
    'type',
    'required',
    'public',
    'searchable',
    'filterable',
    'sortable',
    'sensitive',
    'offlineCache',
    'validation',
    'options',
    'displayOrder',
  ],
  properties: {
    id: uuid,
    revisionId: uuid,
    key: { type: 'string' },
    label: { type: 'string' },
    description: nullableString,
    type: { type: 'string' },
    icon: nullableString,
    required: { type: 'boolean' },
    public: { type: 'boolean' },
    searchable: { type: 'boolean' },
    filterable: { type: 'boolean' },
    sortable: { type: 'boolean' },
    sensitive: { type: 'boolean' },
    offlineCache: { type: 'boolean' },
    defaultValue: { nullable: true },
    validation: jsonObject,
    options: { type: 'array', items: {} },
    displayOrder: { type: 'integer' },
  },
};

export const createLayerResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['layer', 'draftRevision'],
  properties: { layer: adminLayerEntitySchema, draftRevision: adminRevisionSchema },
};

export const revisionResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['revision', 'fields'],
  properties: {
    revision: adminRevisionSchema,
    fields: { type: 'array', items: adminLayerFieldSchema },
  },
};

export const revisionWorkspaceSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'revisionId',
    'layerId',
    'status',
    'serverCursor',
    'featureCount',
    'bounds',
    'schemaVersion',
    'updatedAt',
  ],
  properties: {
    revisionId: uuid,
    layerId: uuid,
    status: { type: 'string' },
    serverCursor: { type: 'string' },
    featureCount: { type: 'integer', minimum: 0 },
    bounds: {
      type: 'array',
      nullable: true,
      minItems: 4,
      maxItems: 4,
      items: { type: 'number' },
    },
    schemaVersion: { type: 'integer' },
    updatedAt: dateTime,
  },
};

export const adminFeatureSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id', 'geometry', 'properties', 'attachments', 'meta'],
  properties: {
    type: { type: 'string', enum: ['Feature'] },
    id: uuid,
    geometry: geoJsonGeometrySchema,
    properties: jsonObject,
    attachments: { type: 'array', items: jsonObject },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: [
        'geometryKind',
        'radiusM',
        'externalSource',
        'externalId',
        'versionId',
        'updatedAt',
      ],
      properties: {
        geometryKind: { type: 'string' },
        radiusM: { type: 'number', nullable: true },
        externalSource: nullableString,
        externalId: nullableString,
        versionId: uuid,
        updatedAt: dateTime,
      },
    },
  },
};

export const featureMutationResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['feature', 'serverCursor'],
  properties: { feature: adminFeatureSchema, serverCursor: { type: 'string' } },
};

export const featureDeleteResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'serverCursor'],
  properties: {
    status: { type: 'string', enum: ['deleted'] },
    serverCursor: { type: 'string' },
  },
};

export const importJobSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'revisionId',
    'status',
    'format',
    'mode',
    'file',
    'progress',
    'counts',
    'inspection',
    'canApplyWithSkipInvalid',
  ],
  properties: {
    id: uuid,
    revisionId: uuid,
    status: {
      type: 'string',
      enum: [
        'uploaded',
        'inspecting',
        'mapping_required',
        'validating',
        'ready',
        'applying',
        'completed',
        'failed',
        'cancelled',
      ],
    },
    format: { type: 'string', enum: ['csv', 'xlsx', 'geojson', 'kml'] },
    mode: { type: 'string', enum: ['append', 'replace', 'upsert'] },
    file: {
      type: 'object',
      required: ['name', 'sizeBytes'],
      properties: { name: { type: 'string' }, sizeBytes: { type: 'integer' } },
    },
    progress: { type: 'integer', minimum: 0, maximum: 100 },
    counts: {
      type: 'object',
      additionalProperties: { type: 'number' },
      properties: {
        total: { type: 'integer' },
        valid: { type: 'integer' },
        warning: { type: 'integer' },
        invalid: { type: 'integer' },
        matched: { type: 'integer' },
        new: { type: 'integer' },
        applied: { type: 'integer' },
        skipped: { type: 'integer' },
      },
    },
    inspection: {
      type: 'object',
      additionalProperties: false,
      required: ['parserStatus', 'sheets', 'limits'],
      properties: {
        parserStatus: { type: 'string', enum: ['pending', 'inspected'] },
        sheets: { type: 'array', items: { type: 'string' } },
        limits: {
          type: 'object',
          additionalProperties: false,
          required: [
            'maxRecords',
            'maxVerticesPerFeature',
            'maxVerticesPerJob',
            'maxExpandedBytes',
            'maxIssues',
          ],
          properties: {
            maxRecords: { type: 'integer', nullable: true },
            maxVerticesPerFeature: { type: 'integer', nullable: true },
            maxVerticesPerJob: { type: 'integer', nullable: true },
            maxExpandedBytes: { type: 'integer', nullable: true },
            maxIssues: { type: 'integer', nullable: true },
          },
        },
      },
    },
    canApplyWithSkipInvalid: { type: 'boolean' },
    failureCode: nullableString,
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};

export const importIssueSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'rowNumber', 'severity', 'code'],
  properties: {
    id: { type: 'string' },
    rowNumber: { type: 'integer', minimum: 1 },
    severity: { type: 'string', enum: ['warning', 'error'] },
    code: { type: 'string' },
    field: nullableString,
  },
};

export const importIssueMetaSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['requestId', 'nextCursor', 'hasMore', 'limit'],
  properties: {
    requestId: { type: 'string' },
    nextCursor: nullableString,
    hasMore: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
};

export const workflowResultSchema: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['revisionId', 'status'],
      properties: { revisionId: uuid, status: { type: 'string' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'originalRevisionId',
        'draftRevisionId',
        'supersedesRevisionId',
        'originalStatus',
        'draftStatus',
        'draftEtag',
      ],
      properties: {
        originalRevisionId: uuid,
        draftRevisionId: uuid,
        supersedesRevisionId: uuid,
        originalStatus: { type: 'string' },
        draftStatus: { type: 'string' },
        draftEtag: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['snapshotId', 'generation', 'status'],
      properties: {
        publicationId: uuid,
        snapshotId: uuid,
        generation: { type: 'integer' },
        status: { type: 'string', enum: ['completed'] },
      },
    },
  ],
};

export const livenessSchema: SchemaObject = {
  type: 'object',
  required: ['status', 'version'],
  properties: { status: { type: 'string', enum: ['ok'] }, version: { type: 'string' } },
};

export const readinessSchema: SchemaObject = {
  type: 'object',
  required: ['status', 'version', 'checks'],
  properties: {
    status: { type: 'string', enum: ['ok'] },
    version: { type: 'string' },
    checks: {
      type: 'object',
      additionalProperties: { type: 'string', enum: ['up', 'down', 'degraded', 'current'] },
    },
  },
};
