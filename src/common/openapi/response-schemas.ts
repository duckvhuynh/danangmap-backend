import { ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const dateTime: SchemaObject = { type: 'string', format: 'date-time' };
const nullableString: SchemaObject = { type: 'string', nullable: true };
const jsonObject: SchemaObject = { type: 'object', additionalProperties: true };
const color: SchemaObject = { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' };

export const attachmentStatusSchema: SchemaObject = {
  type: 'string',
  enum: ['uploading', 'pending', 'clean', 'infected', 'rejected', 'deleted'],
};

export const featureAttachmentSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'fieldKey', 'displayOrder', 'fileName', 'contentType', 'sizeBytes', 'status'],
  properties: {
    id: uuid,
    fieldKey: { type: 'string' },
    displayOrder: { type: 'integer', minimum: 0 },
    fileName: { type: 'string' },
    contentType: { type: 'string' },
    sizeBytes: { type: 'integer', minimum: 1, maximum: 25 * 1024 * 1024 },
    status: attachmentStatusSchema,
    url: { type: 'string', nullable: true },
  },
};

const pointStyleSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    color,
    radius: { type: 'number', minimum: 1, maximum: 64 },
    strokeColor: color,
    strokeWidth: { type: 'number', minimum: 0, maximum: 16 },
    cluster: { type: 'boolean' },
  },
};

const lineStyleSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    color,
    width: { type: 'number', minimum: 0.5, maximum: 32 },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const polygonStyleSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fillColor: color,
    fillOpacity: { type: 'number', minimum: 0, maximum: 1 },
    strokeColor: color,
    strokeWidth: { type: 'number', minimum: 0, maximum: 16 },
  },
};

export const layerStyleSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    point: pointStyleSchema,
    line: lineStyleSchema,
    polygon: polygonStyleSchema,
  },
};

export const layerRenderConfigSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    minZoom: { type: 'integer', minimum: 0, maximum: 24 },
    maxZoom: { type: 'integer', minimum: 0, maximum: 24 },
    cluster: { type: 'boolean' },
    sourcePolicy: { type: 'string', enum: ['auto', 'geojson', 'mvt', 'hybrid'] },
  },
};

export const layerPopupConfigSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    titleField: { type: 'string' },
    subtitleField: { type: 'string' },
    fieldKeys: { type: 'array', maxItems: 100, items: { type: 'string' } },
    showCoordinates: { type: 'boolean' },
  },
};

export const layerFieldValidationSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    minLength: { type: 'integer', minimum: 0, maximum: 10_000 },
    maxLength: { type: 'integer', minimum: 1, maximum: 10_000 },
    minimum: { type: 'number' },
    maximum: { type: 'number' },
  },
};

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

export const apiVersionedJsonResponse = (status: number, data: SchemaObject, meta?: SchemaObject) =>
  ApiResponse({
    status,
    headers: {
      ETag: {
        description: 'Opaque version token for the returned representation.',
        schema: { type: 'string' },
      },
    },
    schema: envelopeSchema(data, meta),
  });

export const apiRawJsonResponse = (status: number, schema: SchemaObject) =>
  ApiResponse({ status, content: { 'application/json': { schema } } });

export const apiBinaryResponse = (status: number, mediaType: string) =>
  ApiResponse({
    status,
    content: { [mediaType]: { schema: { type: 'string', format: 'binary' } } },
  });

export const problemDetailsSchema = (status: number, codes: string[]): SchemaObject => ({
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'code', 'message', 'details', 'requestId', 'timestamp'],
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer', enum: [status] },
    code: { type: 'string', enum: codes },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    requestId: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
  },
});

export const apiProblemResponse = (status: number, codes: string[]) =>
  ApiResponse({
    status,
    content: {
      'application/problem+json': { schema: problemDetailsSchema(status, codes) },
    },
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

export const bootstrapStatusSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['available'],
  properties: { available: { type: 'boolean' } },
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
    requiresMfaEnrollment: { type: 'boolean' },
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

const identityEtagSchema: SchemaObject = {
  type: 'string',
  pattern: '^"(?:user|invite)-[0-9a-f-]{36}-v[1-9]\\d*"$',
};

export const adminUserListItemSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'email',
    'username',
    'displayName',
    'role',
    'status',
    'mfaEnabled',
    'mustChangePassword',
    'disabledAt',
    'lockedUntil',
    'lockVersion',
    'etag',
    'createdAt',
    'updatedAt',
    'security',
  ],
  properties: {
    ...authPrincipalSchema.properties,
    disabledAt: { ...dateTime, nullable: true },
    lockedUntil: { ...dateTime, nullable: true },
    lockVersion: { type: 'integer', minimum: 1 },
    etag: identityEtagSchema,
    createdAt: dateTime,
    updatedAt: dateTime,
    security: {
      type: 'object',
      additionalProperties: false,
      required: [
        'activeSessionCount',
        'latestSessionCreatedAt',
        'recoveryCodesRemaining',
        'pendingInviteCount',
        'pendingPasswordReset',
      ],
      properties: {
        activeSessionCount: { type: 'integer', minimum: 0 },
        latestSessionCreatedAt: { ...dateTime, nullable: true },
        recoveryCodesRemaining: { type: 'integer', minimum: 0 },
        pendingInviteCount: { type: 'integer', minimum: 0 },
        pendingPasswordReset: { type: 'boolean' },
      },
    },
  },
};

const adminSessionSummarySchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'status', 'createdAt', 'expiresAt', 'revokedAt', 'userAgent'],
  properties: {
    id: uuid,
    kind: { type: 'string', enum: ['preauth', 'authenticated'] },
    status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
    createdAt: dateTime,
    expiresAt: dateTime,
    revokedAt: { ...dateTime, nullable: true },
    userAgent: nullableString,
  },
};

const adminUserInviteSummarySchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status', 'expiresAt', 'createdAt', 'mailStatus', 'etag'],
  properties: {
    id: uuid,
    status: { type: 'string', enum: ['pending', 'expired', 'revoked', 'accepted'] },
    expiresAt: dateTime,
    createdAt: dateTime,
    mailStatus: { type: 'string', nullable: true },
    etag: identityEtagSchema,
  },
};

const adminPasswordResetSummarySchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status', 'expiresAt', 'createdAt', 'mailStatus'],
  properties: {
    id: uuid,
    status: { type: 'string', enum: ['pending', 'expired', 'revoked', 'used'] },
    expiresAt: dateTime,
    createdAt: dateTime,
    mailStatus: { type: 'string', nullable: true },
  },
};

export const adminUserDetailSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'email',
    'username',
    'displayName',
    'role',
    'status',
    'mustChangePassword',
    'disabledAt',
    'lockedUntil',
    'failedLoginCount',
    'lockVersion',
    'etag',
    'createdAt',
    'updatedAt',
    'mfa',
    'sessions',
    'invites',
    'passwordResets',
  ],
  properties: {
    id: uuid,
    email: { type: 'string', format: 'email' },
    username: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: ['editor', 'reviewer', 'publisher', 'system_admin'] },
    status: { type: 'string', enum: ['active', 'inactive', 'disabled', 'invited'] },
    mustChangePassword: { type: 'boolean' },
    disabledAt: { ...dateTime, nullable: true },
    lockedUntil: { ...dateTime, nullable: true },
    failedLoginCount: { type: 'integer', minimum: 0 },
    lockVersion: { type: 'integer', minimum: 1 },
    etag: identityEtagSchema,
    createdAt: dateTime,
    updatedAt: dateTime,
    mfa: {
      type: 'object',
      additionalProperties: false,
      required: [
        'enabled',
        'status',
        'verifiedAt',
        'recoveryCodesRemaining',
        'recoveryCodesConsumed',
      ],
      properties: {
        enabled: { type: 'boolean' },
        status: { type: 'string', enum: ['not_enrolled', 'pending', 'verified'] },
        verifiedAt: { ...dateTime, nullable: true },
        recoveryCodesRemaining: { type: 'integer', minimum: 0 },
        recoveryCodesConsumed: { type: 'integer', minimum: 0 },
      },
    },
    sessions: { type: 'array', maxItems: 50, items: adminSessionSummarySchema },
    invites: { type: 'array', maxItems: 20, items: adminUserInviteSummarySchema },
    passwordResets: { type: 'array', maxItems: 10, items: adminPasswordResetSummarySchema },
  },
};

export const adminInviteSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'email',
    'username',
    'displayName',
    'role',
    'status',
    'expiresAt',
    'usedAt',
    'revokedAt',
    'acceptedUserId',
    'supersedesInviteId',
    'mailStatus',
    'lockVersion',
    'etag',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    email: { type: 'string', format: 'email' },
    username: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: ['editor', 'reviewer', 'publisher', 'system_admin'] },
    status: { type: 'string', enum: ['pending', 'expired', 'revoked', 'accepted'] },
    expiresAt: dateTime,
    usedAt: { ...dateTime, nullable: true },
    revokedAt: { ...dateTime, nullable: true },
    acceptedUserId: { ...uuid, nullable: true },
    supersedesInviteId: { ...uuid, nullable: true },
    mailStatus: { type: 'string', nullable: true },
    lockVersion: { type: 'integer', minimum: 1 },
    etag: identityEtagSchema,
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};

export const adminInviteResendResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'email',
    'username',
    'displayName',
    'role',
    'status',
    'expiresAt',
    'supersedesInviteId',
    'mailStatus',
    'lockVersion',
    'etag',
  ],
  properties: {
    id: uuid,
    email: { type: 'string', format: 'email' },
    username: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: ['editor', 'reviewer', 'publisher', 'system_admin'] },
    status: { type: 'string', enum: ['pending'] },
    expiresAt: dateTime,
    supersedesInviteId: uuid,
    mailStatus: { type: 'string', enum: ['pending'] },
    lockVersion: { type: 'integer', minimum: 1 },
    etag: identityEtagSchema,
  },
};

export const adminSessionRevocationResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'status', 'scope', 'sessionId', 'revokedCount', 'etag'],
  properties: {
    userId: uuid,
    status: { type: 'string', enum: ['sessions_revoked'] },
    scope: { type: 'string', enum: ['one', 'all'] },
    sessionId: { ...uuid, nullable: true },
    revokedCount: { type: 'integer', minimum: 1 },
    etag: identityEtagSchema,
  },
};

export const adminMfaResetResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'status', 'mfaEnrollmentRequired', 'sessionsRevoked', 'etag'],
  properties: {
    userId: uuid,
    status: { type: 'string', enum: ['mfa_reset'] },
    mfaEnrollmentRequired: { type: 'boolean', enum: [true] },
    sessionsRevoked: { type: 'integer', minimum: 0 },
    etag: identityEtagSchema,
  },
};

export const adminPasswordResetRequestResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'status', 'deliveryStatus', 'expiresAt', 'mailOutboxId', 'etag'],
  properties: {
    userId: uuid,
    status: { type: 'string', enum: ['accepted'] },
    deliveryStatus: { type: 'string', enum: ['pending'] },
    expiresAt: dateTime,
    mailOutboxId: uuid,
    etag: identityEtagSchema,
  },
};

export const loginResultSchema: SchemaObject = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'mfaEnrollmentRequired', 'challengeExpiresAt'],
      properties: {
        status: { type: 'string', enum: ['mfa_required'] },
        mfaEnrollmentRequired: { type: 'boolean' },
        challengeExpiresAt: dateTime,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'mfaEnrollmentRequired', 'principal'],
      properties: {
        status: { type: 'string', enum: ['authenticated'] },
        mfaEnrollmentRequired: { type: 'boolean', enum: [false] },
        principal: authPrincipalSchema,
      },
    },
  ],
};

export const csrfResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['csrfToken'],
  properties: {
    csrfToken: {
      type: 'string',
      minLength: 32,
      maxLength: 32,
      pattern: '^[A-Za-z0-9_-]{32}$',
    },
  },
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

export const recoveryCodesRegenerationSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'recoveryCodes'],
  properties: {
    status: { type: 'string', enum: ['recovery_codes_regenerated'] },
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
    'defaultVisible',
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
    defaultVisible: { type: 'boolean' },
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
    style: layerStyleSchema,
    popupConfig: layerPopupConfigSchema,
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
          validation: layerFieldValidationSchema,
          options: { type: 'array', items: { type: 'string' } },
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
    attachments: { type: 'array', items: featureAttachmentSchema },
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
  required: ['id', 'slug', 'title', 'displayOrder', 'defaultVisible', 'lockVersion'],
  properties: {
    id: uuid,
    slug: { type: 'string' },
    title: { type: 'string' },
    description: nullableString,
    displayOrder: { type: 'integer' },
    defaultVisible: { type: 'boolean' },
    lockVersion: { type: 'integer', minimum: 1 },
    archivedAt: { ...dateTime, nullable: true },
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};

export const adminLayerListItemSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'displayOrder', 'defaultVisible', 'lockVersion'],
  properties: {
    id: uuid,
    slug: { type: 'string' },
    groupId: { ...uuid, nullable: true },
    displayOrder: { type: 'integer' },
    defaultVisible: { type: 'boolean' },
    lockVersion: { type: 'integer', minimum: 1 },
    archivedAt: { ...dateTime, nullable: true },
    revisionId: { ...uuid, nullable: true },
    revisionLockVersion: { type: 'integer', minimum: 1, nullable: true },
    title: { ...nullableString },
    status: { ...nullableString },
    geometryMode: { ...nullableString },
    updatedAt: { ...dateTime, nullable: true },
  },
};

export const adminLayerEntitySchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'slug',
    'groupId',
    'displayOrder',
    'defaultVisible',
    'lockVersion',
    'createdBy',
    'archivedAt',
  ],
  properties: {
    id: uuid,
    slug: { type: 'string' },
    groupId: { ...uuid, nullable: true },
    displayOrder: { type: 'integer' },
    defaultVisible: { type: 'boolean' },
    lockVersion: { type: 'integer', minimum: 1 },
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
    style: layerStyleSchema,
    renderConfig: layerRenderConfigSchema,
    popupConfig: layerPopupConfigSchema,
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
    validation: layerFieldValidationSchema,
    options: { type: 'array', items: { type: 'string' } },
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

export const adminLayerDetailSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['layer', 'latestRevision', 'draftRevision', 'publishedRevision'],
  properties: {
    layer: adminLayerEntitySchema,
    latestRevision: { ...adminRevisionSchema, nullable: true },
    draftRevision: { ...adminRevisionSchema, nullable: true },
    publishedRevision: { ...adminRevisionSchema, nullable: true },
  },
};

export const catalogReorderResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['updatedCount', 'items'],
  properties: {
    updatedCount: { type: 'integer', minimum: 1 },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'displayOrder', 'lockVersion'],
        properties: {
          id: uuid,
          displayOrder: { type: 'integer' },
          lockVersion: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
};

export const revisionConfigurationImpactSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['featureCount', 'blocking', 'schemaVersionWillIncrement', 'reasons'],
  properties: {
    featureCount: { type: 'integer', minimum: 0 },
    blocking: { type: 'boolean' },
    schemaVersionWillIncrement: { type: 'boolean' },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'affectedFeatures'],
        properties: {
          code: {
            type: 'string',
            enum: [
              'GEOMETRY_KIND_IN_USE',
              'FIELD_REMOVAL_WITH_DATA',
              'FIELD_CONSTRAINT_CHANGE_WITH_DATA',
              'REQUIRED_FIELD_MISSING',
            ],
          },
          fieldKey: nullableString,
          geometryKind: nullableString,
          affectedFeatures: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
};

export const revisionConfigurationResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['revision', 'fields', 'impact'],
  properties: {
    revision: adminRevisionSchema,
    fields: { type: 'array', items: adminLayerFieldSchema },
    impact: revisionConfigurationImpactSchema,
  },
};

export const successorDraftResultSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceRevisionId', 'draftRevision', 'draftEtag', 'featureCount'],
  properties: {
    sourceRevisionId: uuid,
    draftRevision: adminRevisionSchema,
    draftEtag: { type: 'string' },
    featureCount: { type: 'integer', minimum: 0 },
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
    attachments: { type: 'array', items: featureAttachmentSchema },
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

export const userImportJobSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'status',
    'format',
    'file',
    'progress',
    'counts',
    'inspection',
    'validRowPolicy',
    'failureCode',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    status: {
      type: 'string',
      enum: [
        'uploaded',
        'inspecting',
        'inspected',
        'validating',
        'ready',
        'applying',
        'completed',
        'failed',
      ],
    },
    format: { type: 'string', enum: ['csv', 'xlsx'] },
    file: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'sizeBytes'],
      properties: {
        name: { type: 'string' },
        sizeBytes: { type: 'integer', minimum: 1, maximum: 5 * 1024 * 1024 },
      },
    },
    progress: { type: 'integer', minimum: 0, maximum: 100 },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'valid', 'invalid', 'applied', 'skipped'],
      properties: {
        total: { type: 'integer', minimum: 0, maximum: 5000 },
        valid: { type: 'integer', minimum: 0, maximum: 5000 },
        invalid: { type: 'integer', minimum: 0, maximum: 5000 },
        applied: { type: 'integer', minimum: 0, maximum: 5000 },
        skipped: { type: 'integer', minimum: 0, maximum: 5000 },
      },
    },
    inspection: {
      type: 'object',
      additionalProperties: false,
      required: ['sheets', 'selectedSheet', 'limits'],
      properties: {
        sheets: { type: 'array', maxItems: 10, items: { type: 'string' } },
        selectedSheet: nullableString,
        limits: {
          type: 'object',
          additionalProperties: false,
          required: ['maxBytes', 'maxRows', 'maxSheets', 'maxColumns', 'maxExpandedBytes'],
          properties: {
            maxBytes: { type: 'integer', enum: [5 * 1024 * 1024] },
            maxRows: { type: 'integer', enum: [5000] },
            maxSheets: { type: 'integer', enum: [10] },
            maxColumns: { type: 'integer', enum: [4] },
            maxExpandedBytes: { type: 'integer', enum: [50 * 1024 * 1024] },
          },
        },
      },
    },
    validRowPolicy: { type: 'string', enum: ['invite'] },
    failureCode: nullableString,
    createdAt: dateTime,
    updatedAt: dateTime,
  },
};

export const userImportIssueSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'rowNumber', 'severity', 'code', 'field'],
  properties: {
    id: { type: 'string', pattern: '^\\d+$' },
    rowNumber: { type: 'integer', minimum: 2, maximum: 5001 },
    severity: { type: 'string', enum: ['error'] },
    code: { type: 'string' },
    field: { type: 'string', enum: ['email', 'username', 'displayName', 'role'], nullable: true },
  },
};

export const userImportIssueMetaSchema: SchemaObject = {
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

export const userImportReportSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['job', 'issues'],
  properties: {
    job: userImportJobSchema,
    issues: { type: 'array', items: userImportIssueSchema },
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

const featureSyncAppliedSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'clientMutationId',
    'status',
    'operation',
    'clientFeatureId',
    'canonicalFeatureId',
    'versionId',
    'serverCursor',
  ],
  properties: {
    clientMutationId: uuid,
    status: { type: 'string', enum: ['applied'] },
    operation: { type: 'string', enum: ['create', 'update', 'delete'] },
    clientFeatureId: { ...uuid, nullable: true },
    canonicalFeatureId: uuid,
    versionId: { ...uuid, nullable: true },
    serverCursor: { type: 'string' },
  },
};

const featureSyncConflictSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'clientMutationId',
    'status',
    'operation',
    'canonicalFeatureId',
    'serverCursor',
    'conflict',
  ],
  properties: {
    clientMutationId: uuid,
    status: { type: 'string', enum: ['conflict'] },
    operation: { type: 'string', enum: ['update', 'delete'] },
    canonicalFeatureId: uuid,
    serverCursor: { type: 'string' },
    conflict: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'currentVersionId', 'changedPaths'],
      properties: {
        code: { type: 'string', enum: ['FEATURE_VERSION_CHANGED'] },
        currentVersionId: uuid,
        changedPaths: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const featureSyncRejectedSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'clientMutationId',
    'status',
    'operation',
    'canonicalFeatureId',
    'serverCursor',
    'error',
  ],
  properties: {
    clientMutationId: uuid,
    status: { type: 'string', enum: ['rejected'] },
    operation: { type: 'string', enum: ['create', 'update', 'delete'] },
    canonicalFeatureId: { ...uuid, nullable: true },
    serverCursor: { type: 'string' },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'details'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: jsonObject,
      },
    },
  },
};

export const featureBatchSyncSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['revisionId', 'serverCursor', 'results'],
  properties: {
    revisionId: uuid,
    serverCursor: { type: 'string' },
    results: {
      type: 'array',
      maxItems: 100,
      items: {
        oneOf: [featureSyncAppliedSchema, featureSyncConflictSchema, featureSyncRejectedSchema],
      },
    },
  },
};

export const revisionChangeSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'serverCursor',
    'operation',
    'featureId',
    'versionId',
    'changedPaths',
    'actor',
    'changedAt',
  ],
  properties: {
    serverCursor: { type: 'string' },
    operation: { type: 'string', enum: ['create', 'update', 'delete'] },
    featureId: uuid,
    versionId: { ...uuid, nullable: true },
    changedPaths: { type: 'array', items: { type: 'string' } },
    actor: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'displayName'],
      properties: { id: uuid, displayName: { type: 'string' } },
    },
    changedAt: dateTime,
  },
};

export const revisionChangeMetaSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['requestId', 'nextCursor', 'hasMore', 'limit'],
  properties: {
    requestId: { type: 'string' },
    nextCursor: { type: 'string' },
    hasMore: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
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
      additionalProperties: false,
      required: ['postgres', 'redis', 'migrations', 'minio', 'geoService', 'mail', 'publication'],
      properties: {
        postgres: { type: 'string', enum: ['up', 'down'] },
        redis: { type: 'string', enum: ['up', 'down'] },
        migrations: { type: 'string', enum: ['current', 'down'] },
        minio: { type: 'string', enum: ['up', 'down'] },
        geoService: { type: 'string', enum: ['up', 'degraded'] },
        mail: { type: 'string', enum: ['up', 'degraded'] },
        publication: { type: 'string', enum: ['up', 'degraded', 'disabled'] },
      },
    },
  },
};
