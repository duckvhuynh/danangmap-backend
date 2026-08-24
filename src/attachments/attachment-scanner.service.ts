import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'node:net';

export type AttachmentScanVerdict =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'rejected'; code: string };

@Injectable()
export class AttachmentScannerService {
  constructor(private readonly config: ConfigService) {}

  async scan(buffer: Buffer): Promise<AttachmentScanVerdict> {
    return this.config.getOrThrow<string>('attachments.scannerMode') === 'clamav'
      ? this.scanWithClamAv(buffer)
      : this.scanDeterministically(buffer);
  }

  private scanDeterministically(buffer: Buffer): AttachmentScanVerdict {
    const content = buffer.toString('latin1');
    if (content.includes('DANANGMAP_SCAN_ERROR')) throw new Error('ATTACHMENT_SCANNER_UNAVAILABLE');
    if (content.includes('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) {
      return { status: 'infected', signature: 'EICAR-Test-Signature' };
    }
    if (content.includes('DANANGMAP_SCAN_REJECT')) {
      return { status: 'rejected', code: 'ATTACHMENT_SCAN_REJECTED' };
    }
    return { status: 'clean' };
  }

  private async scanWithClamAv(buffer: Buffer): Promise<AttachmentScanVerdict> {
    const host = this.config.getOrThrow<string>('attachments.clamavHost');
    const port = this.config.getOrThrow<number>('attachments.clamavPort');
    const timeoutMs = this.config.getOrThrow<number>('attachments.scanTimeoutMs');
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host, port });
      const chunks: Buffer[] = [];
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('ATTACHMENT_SCAN_TIMEOUT')));
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '')));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < buffer.byteLength; offset += 64 * 1024) {
          const chunk = buffer.subarray(offset, Math.min(offset + 64 * 1024, buffer.byteLength));
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(chunk.byteLength);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
        socket.end();
      });
    });
    if (response.endsWith(' OK')) return { status: 'clean' };
    const infected = /: (.+) FOUND$/.exec(response);
    if (infected) return { status: 'infected', signature: infected[1] ?? 'malware' };
    if (response.endsWith(' ERROR'))
      return { status: 'rejected', code: 'ATTACHMENT_SCAN_REJECTED' };
    throw new Error('ATTACHMENT_SCANNER_INVALID_RESPONSE');
  }
}
