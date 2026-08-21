import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';

const CONSUME_SCRIPT = `
local globalCount = redis.call('INCR', KEYS[1])
if globalCount == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local tokenCount = redis.call('INCR', KEYS[2])
if tokenCount == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
return {globalCount, redis.call('PTTL', KEYS[1]), tokenCount, redis.call('PTTL', KEYS[2])}
`;

@Injectable()
export class IdentityRateLimitService implements OnApplicationShutdown {
  private readonly redis: Redis;

  constructor(
    config: ConfigService,
    private readonly crypto: CryptoService,
  ) {
    this.redis = new Redis({
      host: config.getOrThrow<string>('redis.host'),
      port: config.getOrThrow<number>('redis.port'),
      password: config.get<string>('redis.password'),
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  enforceInviteInspect(ip: string | undefined, token: string): Promise<void> {
    return this.consume('invite_inspect', ip, token, 120, 30, 60);
  }

  enforceInviteAccept(ip: string | undefined, token: string): Promise<void> {
    return this.consume('invite_accept', ip, token, 30, 5, 5 * 60);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    if (this.redis.status === 'wait') {
      this.redis.disconnect();
      return;
    }
    await this.redis.quit().catch(() => this.redis.disconnect());
  }

  private async consume(
    scope: string,
    ip: string | undefined,
    token: string,
    ipLimit: number,
    tokenLimit: number,
    windowSeconds: number,
  ): Promise<void> {
    const ipDigest = this.crypto.digest(`ip:${ip ?? 'unknown'}`);
    const tokenDigest = this.crypto.digest(`token:${token}`);
    const prefix = `{identity-rate}:${scope}`;
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const result = (await this.redis.eval(
        CONSUME_SCRIPT,
        2,
        `${prefix}:ip:${ipDigest}`,
        `${prefix}:token:${tokenDigest}`,
        windowSeconds * 1_000,
      )) as [number, number, number, number];
      const [ipCount, ipTtl, tokenCount, tokenTtl] = result;
      if (ipCount <= ipLimit && tokenCount <= tokenLimit) return;
      const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(ipTtl, tokenTtl) / 1_000));
      throw new AppException(429, 'RATE_LIMITED', 'Có quá nhiều yêu cầu. Vui lòng thử lại sau.', {
        retryAfterSeconds,
      });
    } catch (error) {
      if (error instanceof AppException) throw error;
      throw new AppException(
        503,
        'AUTH_RATE_LIMIT_UNAVAILABLE',
        'Không thể xác minh giới hạn yêu cầu lúc này.',
      );
    }
  }
}
