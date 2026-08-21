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
const resolveSchema = (schema) => {
  if (!schema?.$ref) return schema;
  const prefix = '#/components/schemas/';
  if (!schema.$ref.startsWith(prefix)) throw new Error(`Unsupported schema reference ${schema.$ref}`);
  return document.components?.schemas?.[schema.$ref.slice(prefix.length)];
};
const seen = new Map();
for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem ?? {})) {
    if (!methods.has(method)) continue;
    const operationId = operation?.operationId;
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new Error(`Missing operationId: ${method.toUpperCase()} ${path}`);
    }
    if (seen.has(operationId)) {
      throw new Error(`Duplicate operationId ${operationId}: ${seen.get(operationId)} and ${method.toUpperCase()} ${path}`);
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
      }
    }
    seen.set(operationId, `${method.toUpperCase()} ${path}`);
  }
}
if (seen.size === 0) throw new Error('OpenAPI document has no operations');
const tile = document.paths?.['/api/v1/public/tiles/{slug}/{generation}/{z}/{x}/{y}.pbf']?.get;
if (!tile?.responses?.['200']?.content?.['application/vnd.mapbox-vector-tile']?.schema) {
  throw new Error('MVT success response must declare application/vnd.mapbox-vector-tile');
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
console.log(`Validated ${seen.size} unique operation IDs and typed success responses.`);
