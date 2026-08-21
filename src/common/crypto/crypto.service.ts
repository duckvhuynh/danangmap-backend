import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly pepper: string;

  constructor(config: ConfigService) {
    this.encryptionKey = createHash('sha256')
      .update(config.getOrThrow<string>('FIELD_ENCRYPTION_KEY'))
      .digest();
    this.pepper = config.getOrThrow<string>('SESSION_PEPPER');
  }

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  digest(value: string): string {
    return createHash('sha256').update(`${value}:${this.pepper}`).digest('hex');
  }

  checksum(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }

  encrypt(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [nonce, tag, encrypted].map((value) => value.toString('base64url')).join('.');
  }

  decrypt(payload: string): string {
    const segments = payload.split('.');
    if (segments.length !== 3) throw new Error('Encrypted payload is malformed');
    const [nonceValue, tagValue, encryptedValue] = segments;
    if (!nonceValue || !tagValue || !encryptedValue)
      throw new Error('Encrypted payload is malformed');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(nonceValue, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
