import { mkdir, writeFile } from 'node:fs/promises';

const endpoint = process.env.OPENAPI_URL ?? 'http://localhost:4000/api/openapi.json';
const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
if (!response.ok) {
  throw new Error(`OpenAPI export failed: ${response.status} ${response.statusText}`);
}
const document = await response.json();
await mkdir('openapi', { recursive: true });
await writeFile('openapi/openapi.json', `${JSON.stringify(document, null, 2)}\n`, 'utf8');
