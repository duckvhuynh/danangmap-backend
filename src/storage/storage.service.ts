import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';

@Injectable()
export class StorageService implements OnModuleInit {
  readonly client: Client;
  readonly publicClient: Client;
  readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('minio.bucket');
    this.client = new Client({
      endPoint: config.getOrThrow<string>('minio.endpoint'),
      port: config.getOrThrow<number>('minio.port'),
      useSSL: config.getOrThrow<boolean>('minio.useSsl'),
      region: config.getOrThrow<string>('minio.region'),
      accessKey: config.getOrThrow<string>('minio.accessKey'),
      secretKey: config.getOrThrow<string>('minio.secretKey'),
    });
    this.publicClient = new Client({
      endPoint: config.getOrThrow<string>('minio.publicEndpoint'),
      port: config.getOrThrow<number>('minio.publicPort'),
      useSSL: config.getOrThrow<boolean>('minio.publicUseSsl'),
      accessKey: config.getOrThrow<string>('minio.accessKey'),
      secretKey: config.getOrThrow<string>('minio.secretKey'),
      pathStyle: config.getOrThrow<boolean>('minio.publicPathStyle'),
      region: config.getOrThrow<string>('minio.region'),
    });
  }

  async onModuleInit(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) await this.client.makeBucket(this.bucket);
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.putObject(this.bucket, key, body, body.byteLength, {
      'Content-Type': contentType,
    });
  }

  async stat(key: string) {
    return this.client.statObject(this.bucket, key);
  }

  async getObject(key: string) {
    return this.client.getObject(this.bucket, key);
  }

  async remove(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async removeIfPresent(key: string | null): Promise<void> {
    if (!key) return;
    try {
      await this.remove(key);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(code ?? '')) throw error;
    }
  }

  async presignedPut(key: string, expiresSeconds: number): Promise<string> {
    return this.publicClient.presignedPutObject(this.bucket, key, expiresSeconds);
  }

  async ping(): Promise<void> {
    await this.client.bucketExists(this.bucket);
  }
}
