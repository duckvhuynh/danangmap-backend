import type { Readable } from 'node:stream';
import { AppException } from '../common/http/app.exception';
import { MAX_ATTACHMENT_BYTES } from './attachment-file.policy';

export async function readAttachmentStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += value.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      stream.destroy();
      throw new AppException(413, 'RESOURCE_LIMIT_EXCEEDED', 'Tệp đính kèm vượt quá 25 MiB.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
