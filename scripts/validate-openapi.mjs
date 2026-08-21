import { readFile } from 'node:fs/promises';

const document = JSON.parse(await readFile('openapi/openapi.json', 'utf8'));
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
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
    seen.set(operationId, `${method.toUpperCase()} ${path}`);
  }
}
if (seen.size === 0) throw new Error('OpenAPI document has no operations');
console.log(`Validated ${seen.size} unique OpenAPI operation IDs.`);
