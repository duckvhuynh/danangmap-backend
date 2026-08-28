import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import type { BootstrapSystemAdminDto } from './auth.dto';
import { AdminSessionEntity, UserEntity } from './identity.entities';
import { IdentityRateLimitService } from './identity-rate-limit.service';

interface RequestMetadata {
  requestId: string;
  ip?: string;
  userAgent?: string;
}

const BOOTSTRAP_LOCK_KEY = 'danangmap:identity:first-system-admin-bootstrap:v1';

@Injectable()
export class FirstAdminBootstrapService {
  private readonly configuredToken: string | undefined;
  private readonly mfaEnabled: boolean;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly rateLimits: IdentityRateLimitService,
  ) {
    this.configuredToken = config.get<string>('app.initialAdminBootstrapToken');
    this.mfaEnabled = config.get<boolean>('app.mfaEnabled') ?? false;
  }

  async status(): Promise<{ available: boolean }> {
    if (!this.configuredToken) return { available: false };
    const rows = (await this.dataSource.query(
      'SELECT NOT EXISTS (SELECT 1 FROM users LIMIT 1) AS available',
    )) as Array<{ available: boolean }>;
    return { available: rows[0]?.available === true };
  }

  async createSystemAdmin(
    dto: BootstrapSystemAdminDto,
    presentedToken: string | undefined,
    metadata: RequestMetadata,
  ) {
    try {
      await this.rateLimits.enforceBootstrapSystemAdmin(metadata.ip, presentedToken ?? 'missing');
    } catch (error) {
      await this.appendFailureAudit(metadata.requestId, 'rate_limited');
      throw error;
    }

    if (!this.configuredToken) {
      await this.appendFailureAudit(metadata.requestId, 'unavailable');
      throw new AppException(
        503,
        'BOOTSTRAP_UNAVAILABLE',
        'Khởi tạo quản trị hệ thống chưa được cấu hình.',
      );
    }
    if (!presentedToken || !this.tokensMatch(presentedToken, this.configuredToken)) {
      await this.appendFailureAudit(metadata.requestId, 'invalid_token');
      throw new AppException(
        401,
        'BOOTSTRAP_TOKEN_INVALID',
        'Mã khởi tạo quản trị hệ thống không hợp lệ.',
      );
    }
    if (dto.password !== dto.passwordConfirmation) {
      await this.appendFailureAudit(metadata.requestId, 'password_confirmation_mismatch');
      throw new AppException(422, 'VALIDATION_FAILED', 'Mật khẩu xác nhận không khớp.');
    }
    try {
      this.assertPasswordDoesNotContainIdentity(dto);
    } catch (error) {
      await this.appendFailureAudit(metadata.requestId, 'weak_password');
      throw error;
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          BOOTSTRAP_LOCK_KEY,
        ]);
        const rows = (await manager.query(
          'SELECT EXISTS (SELECT 1 FROM users LIMIT 1) AS completed',
        )) as Array<{ completed: boolean }>;
        if (rows[0]?.completed !== false) {
          throw new AppException(
            409,
            'BOOTSTRAP_ALREADY_COMPLETED',
            'Khởi tạo quản trị hệ thống đã hoàn tất.',
          );
        }

        const email = dto.email.trim().toLowerCase();
        const username = dto.username.trim().toLowerCase();
        const user = await manager.save(UserEntity, {
          email,
          emailNormalized: email,
          username,
          usernameNormalized: username,
          displayName: dto.displayName.trim(),
          role: 'system_admin',
          status: 'active',
          passwordHash,
          mustChangePassword: false,
          mfaEnabled: false,
          mfaSecretEncrypted: null,
          failedLoginCount: 0,
          lockedUntil: null,
          disabledAt: null,
        });
        await manager.query(
          `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
           VALUES($1,'system_admin','auth.bootstrap_system_admin_created','user',$1,$2,$3::jsonb)`,
          [user.id, metadata.requestId, JSON.stringify({ outcome: 'succeeded' })],
        );
        if (!this.mfaEnabled) {
          const session = await this.createAuthenticatedSession(manager, user.id, metadata);
          return {
            sessionKind: 'authenticated' as const,
            token: session.token,
            csrfToken: session.csrfToken,
            data: {
              status: 'authenticated' as const,
              mfaEnrollmentRequired: false,
              principal: this.toPrincipal(user),
            },
          };
        }
        const session = await this.createPreauthSession(manager, user.id, metadata);
        return {
          sessionKind: 'preauth' as const,
          token: session.token,
          csrfToken: session.csrfToken,
          data: {
            status: 'mfa_required' as const,
            mfaEnrollmentRequired: true,
            challengeExpiresAt: session.expiresAt.toISOString(),
          },
        };
      });
    } catch (error) {
      await this.appendFailureAudit(
        metadata.requestId,
        error instanceof AppException && error.code === 'BOOTSTRAP_ALREADY_COMPLETED'
          ? 'already_completed'
          : 'transaction_failed',
      );
      throw error;
    }
  }

  private tokensMatch(presented: string, configured: string): boolean {
    const presentedBytes = Buffer.from(presented, 'utf8');
    const configuredBytes = Buffer.from(configured, 'utf8');
    return (
      presentedBytes.length === configuredBytes.length &&
      timingSafeEqual(presentedBytes, configuredBytes)
    );
  }

  private assertPasswordDoesNotContainIdentity(dto: BootstrapSystemAdminDto): void {
    const normalizedPassword = dto.password.toLowerCase();
    const emailLocalPart = dto.email.trim().toLowerCase().split('@')[0] ?? '';
    const username = dto.username.trim().toLowerCase();
    if (
      (emailLocalPart.length >= 3 && normalizedPassword.includes(emailLocalPart)) ||
      normalizedPassword.includes(username)
    ) {
      throw new AppException(
        422,
        'BOOTSTRAP_PASSWORD_WEAK',
        'Mật khẩu không được chứa email hoặc tên đăng nhập.',
      );
    }
  }

  private async createPreauthSession(
    manager: EntityManager,
    userId: string,
    metadata: RequestMetadata,
  ) {
    const token = this.crypto.randomToken();
    const csrfToken = this.crypto.randomToken(24);
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await manager.save(AdminSessionEntity, {
      userId,
      tokenHash: this.crypto.digest(token),
      csrfHash: this.crypto.digest(csrfToken),
      kind: 'preauth',
      expiresAt,
      revokedAt: null,
      ipHash: metadata.ip ? this.crypto.digest(metadata.ip) : null,
      userAgent: metadata.userAgent?.slice(0, 512) ?? null,
      mfaFailedAttempts: 0,
      mfaLockedUntil: null,
    });
    return { token, csrfToken, expiresAt };
  }

  private async createAuthenticatedSession(
    manager: EntityManager,
    userId: string,
    metadata: RequestMetadata,
  ) {
    const token = this.crypto.randomToken();
    const csrfToken = this.crypto.randomToken(24);
    await manager.save(AdminSessionEntity, {
      userId,
      tokenHash: this.crypto.digest(token),
      csrfHash: this.crypto.digest(csrfToken),
      kind: 'authenticated',
      expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
      revokedAt: null,
      ipHash: metadata.ip ? this.crypto.digest(metadata.ip) : null,
      userAgent: metadata.userAgent?.slice(0, 512) ?? null,
      mfaFailedAttempts: 0,
      mfaLockedUntil: null,
    });
    return { token, csrfToken };
  }

  private toPrincipal(user: UserEntity) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      mfaEnabled: false,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private async appendFailureAudit(requestId: string, reason: string): Promise<void> {
    await this.audit
      .append({
        actorId: null,
        actorRole: null,
        action: 'auth.bootstrap_system_admin_failed',
        resourceType: 'system_bootstrap',
        resourceId: null,
        requestId,
        metadata: { outcome: 'failed', reason },
      })
      .catch(() => undefined);
  }
}
