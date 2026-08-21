import { readFile } from 'node:fs/promises';

const [openApiText, generatedTypes] = await Promise.all([
  readFile('openapi/openapi.json', 'utf8'),
  readFile('openapi/generated-client-types.ts', 'utf8'),
]);
const document = JSON.parse(openApiText);
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const rawOperations = new Set([
  'getLiveness',
  'getReadiness',
  'listPublicFeatures',
  'getPublicTile',
]);
const strictlyTypedResponseOperations = new Set([
  'login',
  'verifyMfa',
  'startMfaEnrollment',
  'confirmMfaEnrollment',
  'rotateCsrf',
  'getCurrentUser',
  'listUsers',
  'createUser',
  'createInvite',
  'listLayerGroups',
  'createLayerGroup',
  'listAdminLayers',
  'createLayer',
  'getRevision',
  'getRevisionWorkspace',
  'listAdminFeatures',
  'createFeature',
  'updateFeature',
  'deleteFeature',
  'createSpatialImport',
  'getSpatialImport',
  'updateSpatialImportMapping',
  'validateSpatialImport',
  'listSpatialImportIssues',
  'applySpatialImport',
  'submitRevision',
  'approveRevision',
  'requestRevisionChanges',
  'publishRevision',
  'rollbackLayer',
]);
const parameterContracts = {
  login: [['header', 'X-CSRF-Token', true]],
  verifyMfa: [['header', 'X-CSRF-Token', true]],
  startMfaEnrollment: [['header', 'X-CSRF-Token', true]],
  confirmMfaEnrollment: [['header', 'X-CSRF-Token', true]],
  createUser: [
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  createInvite: [
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  listPublicFeatures: [
    ['query', 'bbox', false],
    ['query', 'limit', false],
    ['query', 'filter', false],
  ],
  searchPublicMap: [
    ['query', 'q', true],
    ['query', 'sources', false],
    ['query', 'layerIds', false],
    ['query', 'center', false],
    ['query', 'radiusM', false],
    ['query', 'limit', false],
  ],
  getExternalPlace: [['query', 'fields', false]],
  createSpatialImport: [
    ['header', 'If-Match', true],
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  updateSpatialImportMapping: [['header', 'X-CSRF-Token', true]],
  validateSpatialImport: [['header', 'X-CSRF-Token', true]],
  applySpatialImport: [
    ['header', 'If-Match', true],
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  createLayer: [
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  createFeature: [
    ['header', 'If-Match', true],
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  updateFeature: [
    ['header', 'If-Match', true],
    ['header', 'X-CSRF-Token', true],
  ],
  deleteFeature: [
    ['header', 'If-Match', true],
    ['header', 'X-CSRF-Token', true],
  ],
  submitRevision: [
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  approveRevision: [
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  requestRevisionChanges: [
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  publishRevision: [
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
  rollbackLayer: [
    ['header', 'Idempotency-Key', true],
    ['header', 'X-CSRF-Token', true],
  ],
};
const preauthCsrfOperations = new Set(['verifyMfa', 'startMfaEnrollment', 'confirmMfaEnrollment']);
const publicCsrfOperations = new Set(['login']);
const resolveSchema = (schema) => {
  if (!schema?.$ref) return schema;
  const prefix = '#/components/schemas/';
  if (!schema.$ref.startsWith(prefix))
    throw new Error(`Unsupported schema reference ${schema.$ref}`);
  return document.components?.schemas?.[schema.$ref.slice(prefix.length)];
};
const seen = new Map();
const operationsById = new Map();
for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem ?? {})) {
    if (!methods.has(method)) continue;
    const operationId = operation?.operationId;
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new Error(`Missing operationId: ${method.toUpperCase()} ${path}`);
    }
    if (seen.has(operationId)) {
      throw new Error(
        `Duplicate operationId ${operationId}: ${seen.get(operationId)} and ${method.toUpperCase()} ${path}`,
      );
    }
    for (const [location, name, required] of parameterContracts[operationId] ?? []) {
      const parameter = (operation.parameters ?? []).find(
        (candidate) => candidate?.in === location && candidate?.name === name,
      );
      if (!parameter || parameter.required !== required) {
        throw new Error(
          `Parameter contract mismatch: ${operationId} ${location} ${name} required=${required}`,
        );
      }
    }
    if (preauthCsrfOperations.has(operationId)) {
      const security = operation.security ?? [];
      if (
        !security.some(
          (requirement) =>
            Object.hasOwn(requirement, 'preauthSession') && Object.hasOwn(requirement, 'csrf'),
        )
      ) {
        throw new Error(`Pre-auth CSRF security contract missing: ${operationId}`);
      }
    }
    if (
      publicCsrfOperations.has(operationId) &&
      !(operation.security ?? []).some((requirement) => Object.hasOwn(requirement, 'csrf'))
    ) {
      throw new Error(`Public CSRF security contract missing: ${operationId}`);
    }
    for (const [mediaType, media] of Object.entries(operation.requestBody?.content ?? {})) {
      const requestSchema = resolveSchema(media?.schema);
      if (!requestSchema) throw new Error(`Missing request schema: ${operationId} ${mediaType}`);
      if (
        requestSchema.type === 'object' &&
        Object.keys(requestSchema.properties ?? {}).length === 0
      ) {
        throw new Error(`Empty object request schema: ${operationId} ${mediaType}`);
      }
      if (mediaType === 'multipart/form-data') {
        const file = requestSchema.properties?.file;
        if (file?.type !== 'string' || file?.format !== 'binary') {
          throw new Error(`Multipart request lacks binary file schema: ${operationId}`);
        }
        for (const field of ['file', 'mode', 'clientRequestId']) {
          if (!requestSchema.required?.includes(field)) {
            throw new Error(`Multipart request lacks required field ${field}: ${operationId}`);
          }
        }
      }
    }
    const successResponses = Object.entries(operation.responses ?? {}).filter(([status]) =>
      /^2\d\d$/.test(status),
    );
    if (successResponses.length === 0) {
      throw new Error(`Missing success response: ${operationId}`);
    }
    for (const [status, response] of successResponses) {
      const mediaEntries = Object.entries(response?.content ?? {});
      if (mediaEntries.length === 0) {
        throw new Error(`Missing response content: ${operationId} ${status}`);
      }
      for (const [mediaType, media] of mediaEntries) {
        if (!media?.schema || Object.keys(media.schema).length === 0) {
          throw new Error(`Missing response schema: ${operationId} ${status} ${mediaType}`);
        }
      }
      if (!rawOperations.has(operationId)) {
        const jsonSchema = response.content?.['application/json']?.schema;
        if (!jsonSchema?.properties?.data || !jsonSchema?.properties?.meta) {
          throw new Error(`Success envelope schema missing data/meta: ${operationId} ${status}`);
        }
        if (strictlyTypedResponseOperations.has(operationId)) {
          const dataSchema = resolveSchema(jsonSchema.properties.data);
          const schemasToCheck = [
            dataSchema,
            ...(dataSchema?.type === 'array' ? [resolveSchema(dataSchema.items)] : []),
          ];
          if (
            schemasToCheck.some(
              (schema) =>
                schema?.type === 'object' &&
                schema.additionalProperties === true &&
                Object.keys(schema.properties ?? {}).length === 0,
            )
          ) {
            throw new Error(`Generic success data schema is forbidden: ${operationId} ${status}`);
          }
        }
      }
    }
    operationsById.set(operationId, operation);
    seen.set(operationId, `${method.toUpperCase()} ${path}`);
  }
}
if (seen.size === 0) throw new Error('OpenAPI document has no operations');
const tile = document.paths?.['/api/v1/public/tiles/{slug}/{generation}/{z}/{x}/{y}.pbf']?.get;
if (!tile?.responses?.['200']?.content?.['application/vnd.mapbox-vector-tile']?.schema) {
  throw new Error('MVT success response must declare application/vnd.mapbox-vector-tile');
}
const importMapping = document.components?.schemas?.UpdateImportMappingDto;
for (const optionalField of ['sheet', 'encoding', 'delimiter', 'sourceCrs', 'upsert']) {
  if (importMapping?.required?.includes(optionalField)) {
    throw new Error(`Import mapping field must remain optional: ${optionalField}`);
  }
}
const expectedDelimiterTokens = ['comma', 'semicolon', 'tab', 'pipe'];
if (
  JSON.stringify(importMapping?.properties?.delimiter?.enum) !==
  JSON.stringify(expectedDelimiterTokens)
) {
  throw new Error('Import delimiter tokens drifted from runtime contract');
}
if (!importMapping?.properties?.encoding?.enum?.includes('windows1258')) {
  throw new Error('Import mapping must declare Windows-1258 encoding');
}
const importUpsert = document.components?.schemas?.ImportUpsertMappingDto;
if (
  JSON.stringify(importUpsert?.properties?.matchBy?.enum) !==
  JSON.stringify(['feature_id', 'external_identity'])
) {
  throw new Error('Import upsert match keys drifted from runtime contract');
}
const createImport = operationsById.get('createSpatialImport');
const createImportResponse =
  createImport?.responses?.['202']?.content?.['application/json']?.schema;
const importJob = resolveSchema(createImportResponse?.properties?.data);
const expectedImportStatuses = [
  'uploaded',
  'inspecting',
  'mapping_required',
  'validating',
  'ready',
  'applying',
  'completed',
  'failed',
  'cancelled',
];
if (
  JSON.stringify(importJob?.properties?.status?.enum) !== JSON.stringify(expectedImportStatuses)
) {
  throw new Error('Import job status enum drifted from runtime contract');
}
if (
  JSON.stringify(importJob?.properties?.inspection?.properties?.parserStatus?.enum) !==
    JSON.stringify(['pending', 'inspected']) ||
  !importJob?.properties?.inspection?.required?.includes('sheets') ||
  !importJob?.properties?.inspection?.required?.includes('limits')
) {
  throw new Error('Import inspection descriptor is missing or untyped');
}
const searchPosition =
  operationsById.get('searchPublicMap')?.responses?.['200']?.content?.['application/json']?.schema
    ?.properties?.data?.items?.properties?.position;
const placePosition =
  operationsById.get('getExternalPlace')?.responses?.['200']?.content?.['application/json']?.schema
    ?.properties?.data?.properties?.position;
if (searchPosition?.nullable !== true || placePosition?.nullable !== true) {
  throw new Error('Geo Service position must remain required and nullable');
}
for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
  if (
    schema?.type === 'object' &&
    Object.keys(schema.properties ?? {}).length === 0 &&
    schema.additionalProperties !== true &&
    !schema.oneOf
  ) {
    throw new Error(`Empty component object schema: ${name}`);
  }
}
const componentStart = generatedTypes.indexOf('    schemas: {');
const componentEnd = generatedTypes.indexOf('    responses: never;', componentStart);
if (componentStart < 0 || componentEnd < 0) {
  throw new Error('Generated client components.schemas section not found');
}
const generatedComponentSchemas = generatedTypes.slice(componentStart, componentEnd);
if (generatedComponentSchemas.includes('Record<string, never>')) {
  throw new Error('Generated client contains unusable Record<string, never> request fields');
}
if (!generatedTypes.includes('status: "active" | "inactive" | "disabled" | "invited";')) {
  throw new Error('Generated auth principal status union drifted');
}
if (
  !generatedTypes.includes(
    'status: "uploaded" | "inspecting" | "mapping_required" | "validating" | "ready" | "applying" | "completed" | "failed" | "cancelled";',
  ) ||
  !generatedTypes.includes('parserStatus: "pending" | "inspected";')
) {
  throw new Error('Generated import polling unions are missing');
}
const nullablePositionTypes = generatedTypes.match(
  /position: \{\s+longitude: number;\s+latitude: number;\s+\} \| null;/g,
);
if ((nullablePositionTypes?.length ?? 0) < 2) {
  throw new Error('Generated search and place detail positions must include null');
}
console.log(`Validated ${seen.size} unique operation IDs and typed success responses.`);
