import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';

@Injectable()
export class StorageService implements OnModuleInit {
  readonly client: Client;
  readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('minio.bucket');
    this.client = new Client({
      endPoint: config.getOrThrow<string>('minio.endpoint'),
      port: config.getOrThrow<number>('minio.port'),
      useSSL: config.getOrThrow<boolean>('minio.useSsl'),
      accessKey: config.getOrThrow<string>('minio.accessKey'),
      secretKey: config.getOrThrow<string>('minio.secretKey'),
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

  async ping(): Promise<void> {
    await this.client.bucketExists(this.bucket);
  }
}
