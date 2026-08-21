import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type {
  ChangePasswordDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
} from './auth.dto';
import {
  AdminSessionEntity,
  AuditLogEntity,
  MailOutboxEntity,
  PasswordResetTokenEntity,
  UserEntity,
  UserMfaMethodEntity,
} from './identity.entities';
import { IdentityRateLimitService } from './identity-rate-limit.service';

interface RequestMetadata {
  requestId: string;
  ip?: string;
  userAgent?: string;
}

export interface PasswordChangeResponse {
  status: 'password_changed';
  sessionsRevoked: number;
  sessionRotated: true;
  principal: ReturnType<PasswordSecurityService['toPrincipal']>;
}

export interface PasswordChangeResult {
  owner: boolean;
  sessionToken?: string;
  csrfToken?: string;
  data: PasswordChangeResponse;
}

export interface ResetRequestResponse {
  status: 'accepted';
}

interface PublicReceiptClaim<T> {
  owner: boolean;
  response: T | null;
}

@Injectable()
export class PasswordSecurityService {
  constructor(
    @InjectRepository(PasswordResetTokenEntity)
    private readonly resetTokens: Repository<PasswordResetTokenEntity>,
    private readonly dataSource: DataSource,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimits: IdentityRateLimitService,
  ) {}

  async changePassword(
    userId: string,
    currentSessionId: string,
    actorRole: string,
    dto: ChangePasswordDto,
    metadata: RequestMetadata,
    idempotencyKey: string,
  ): Promise<PasswordChangeResult> {
    if (dto.newPassword !== dto.passwordConfirmation) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Mật khẩu xác nhận không khớp.');
    }
    const requestDigest = this.secretCommandDigest('password.change', {
      userId,
      currentSessionId,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      passwordConfirmation: dto.passwordConfirmation,
    });
    const newPasswordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });
    return this.dataSource.transaction(async (manager) => {
      const claim = await this.idempotency.claim<PasswordChangeResponse>(
        manager,
        userId,
        'password.change',
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) {
        return { owner: false, data: this.replayed(claim.response) };
      }
      const user = await manager.findOne(UserEntity, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      const currentSession = await manager.findOne(AdminSessionEntity, {
        where: { id: currentSessionId, userId, kind: 'authenticated' },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !user ||
        user.status !== 'active' ||
        user.disabledAt ||
        !currentSession ||
        currentSession.revokedAt ||
        currentSession.expiresAt <= new Date()
      ) {
        throw new AppException(401, 'AUTH_SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn.');
      }
      const currentPasswordValid = user.passwordHash
        ? await argon2.verify(user.passwordHash, dto.currentPassword).catch(() => false)
        : false;
      if (!currentPasswordValid) {
        throw new AppException(401, 'AUTH_INVALID_CREDENTIALS', 'Mật khẩu hiện tại không hợp lệ.');
      }
      const reusesCurrentPassword = user.passwordHash
        ? await argon2.verify(user.passwordHash, dto.newPassword).catch(() => false)
        : false;
      if (reusesCurrentPassword) {
        throw new AppException(
          422,
          'PASSWORD_REUSE_FORBIDDEN',
          'Mật khẩu mới phải khác mật khẩu hiện tại.',
        );
      }

      const now = new Date();
      user.passwordHash = newPasswordHash;
      user.mustChangePassword = false;
      user.failedLoginCount = 0;
      user.lockedUntil = null;
      await manager.save(UserEntity, user);
      const resetTokenIds = await this.revokeActiveResetTokens(manager, user.id, now);
      await this.scrubResetOutboxes(manager, resetTokenIds, 'password_changed');
      const revokedSessionIds = await this.revokeSessions(manager, user.id, now);
      const rotated = await this.createAuthenticatedSession(manager, user.id, metadata);
      await this.insertAudit(
        manager,
        user.id,
        actorRole,
        metadata.requestId,
        'auth.password_changed',
        'user',
        user.id,
        {
          sessionsRevoked: revokedSessionIds.length,
          sessionRotated: true,
        },
      );
      const data = {
        status: 'password_changed' as const,
        sessionsRevoked: revokedSessionIds.length,
        sessionRotated: true as const,
        principal: this.toPrincipal(user),
      };
      await this.idempotency.complete(
        manager,
        userId,
        'password.change',
        idempotencyKey,
        data,
        200,
      );
      return {
        owner: true,
        sessionToken: rotated.sessionToken,
        csrfToken: rotated.csrfToken,
        data,
      };
    });
  }

  async requestPasswordReset(
    dto: PasswordResetRequestDto,
    metadata: RequestMetadata,
    idempotencyKey: string,
  ): Promise<ResetRequestResponse> {
    const startedAt = Date.now();
    const normalizedEmail = dto.email.trim().toLowerCase();
    await this.rateLimits.enforcePasswordResetRequest(metadata.ip, normalizedEmail);
    const requestDigest = this.secretCommandDigest('password.reset.request', {
      email: normalizedEmail,
    });
    const resetTokenId = randomUUID();
    const rawToken = this.crypto.randomToken();
    const tokenHash = this.crypto.digest(rawToken);
    const encryptedPayload = this.crypto.encrypt(
      JSON.stringify({ passwordResetTokenId: resetTokenId, token: rawToken }),
    );
    try {
      return await this.dataSource.transaction(async (manager) => {
        const claim = await this.claimPublicReceipt<ResetRequestResponse>(
          manager,
          'password.reset.request',
          idempotencyKey,
          requestDigest,
        );
        if (!claim.owner) return this.replayed(claim.response);

        const user = await manager.findOne(UserEntity, {
          where: { emailNormalized: normalizedEmail },
          lock: { mode: 'pessimistic_write' },
        });
        if (user?.status === 'active' && !user.disabledAt) {
          const now = new Date();
          const supersededIds = await this.revokeActiveResetTokens(manager, user.id, now);
          await this.scrubResetOutboxes(manager, supersededIds, 'superseded');
          await manager.insert(PasswordResetTokenEntity, {
            id: resetTokenId,
            userId: user.id,
            tokenHash,
            expiresAt: new Date(now.getTime() + 30 * 60_000),
            usedAt: null,
            revokedAt: null,
            ipHash: metadata.ip ? this.crypto.digest(metadata.ip) : null,
            userAgent: metadata.userAgent?.slice(0, 512) ?? null,
          });
          await manager.insert(MailOutboxEntity, {
            templateKey: 'identity.password-reset',
            recipientEmail: user.email,
            inviteId: null,
            passwordResetTokenId: resetTokenId,
            payloadEncrypted: encryptedPayload,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            correlationId: metadata.requestId,
          });
          await this.insertAudit(
            manager,
            null,
            null,
            metadata.requestId,
            'auth.password_reset_requested',
            'user',
            user.id,
            {},
          );
        }
        const response = this.resetRequestAccepted();
        await this.completePublicReceipt(
          manager,
          'password.reset.request',
          idempotencyKey,
          response,
          202,
        );
        return response;
      });
    } finally {
      await this.enforceMinimumDuration(startedAt, 150);
    }
  }

  async confirmPasswordReset(dto: PasswordResetConfirmDto, metadata: RequestMetadata) {
    await this.rateLimits.enforcePasswordResetConfirm(metadata.ip, dto.token);
    if (dto.password !== dto.passwordConfirmation) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Mật khẩu xác nhận không khớp.');
    }
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const tokenHash = this.crypto.digest(dto.token);
    const probe = await this.resetTokens.findOneBy({ tokenHash });
    if (!probe) this.throwInvalidPasswordReset();

    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(UserEntity, {
        where: { id: probe.userId },
        lock: { mode: 'pessimistic_write' },
      });
      const resetToken = await manager.findOne(PasswordResetTokenEntity, {
        where: { tokenHash },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !user ||
        user.status !== 'active' ||
        user.disabledAt ||
        !resetToken ||
        resetToken.userId !== user.id ||
        resetToken.usedAt ||
        resetToken.revokedAt ||
        resetToken.expiresAt <= new Date()
      ) {
        this.throwInvalidPasswordReset();
      }

      const now = new Date();
      resetToken.usedAt = now;
      await manager.save(PasswordResetTokenEntity, resetToken);
      const supersededIds = await this.revokeActiveResetTokens(
        manager,
        user.id,
        now,
        resetToken.id,
      );
      user.passwordHash = passwordHash;
      user.mustChangePassword = false;
      user.failedLoginCount = 0;
      user.lockedUntil = null;
      await manager.save(UserEntity, user);
      const revokedSessionIds = await this.revokeSessions(manager, user.id, now);
      await manager.delete(UserMfaMethodEntity, { userId: user.id, status: 'pending' });
      await this.scrubResetOutboxes(manager, [resetToken.id], 'used');
      await this.scrubResetOutboxes(manager, supersededIds, 'superseded');
      await this.insertAudit(
        manager,
        null,
        null,
        metadata.requestId,
        'auth.password_reset_completed',
        'user',
        user.id,
        { sessionsRevoked: revokedSessionIds.length },
      );
      return {
        status: 'password_reset' as const,
        loginRequired: true as const,
        sessionsRevoked: revokedSessionIds.length,
      };
    });
  }

  async revokeAllSessions(
    userId: string,
    currentSessionId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
  ) {
    const requestDigest = this.secretCommandDigest('session.revoke_all', {
      userId,
      currentSessionId,
    });
    return this.dataSource.transaction(async (manager) => {
      const claim = await this.idempotency.claim<{
        status: 'sessions_revoked';
        revokedCount: number;
        currentSessionRevoked: true;
        loginRequired: true;
      }>(manager, userId, 'session.revoke_all', idempotencyKey, requestDigest);
      if (!claim.owner) return this.replayed(claim.response);

      const currentSession = await manager.findOne(AdminSessionEntity, {
        where: { id: currentSessionId, userId, kind: 'authenticated' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!currentSession || currentSession.revokedAt || currentSession.expiresAt <= new Date()) {
        throw new AppException(401, 'AUTH_SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn.');
      }
      const now = new Date();
      const revokedSessionIds = await this.revokeSessions(manager, userId, now);
      const response = {
        status: 'sessions_revoked' as const,
        revokedCount: revokedSessionIds.length,
        currentSessionRevoked: true as const,
        loginRequired: true as const,
      };
      await this.insertAudit(
        manager,
        userId,
        actorRole,
        requestId,
        'auth.sessions_revoked_all',
        'user',
        userId,
        response,
      );
      await this.idempotency.complete(
        manager,
        userId,
        'session.revoke_all',
        idempotencyKey,
        response,
        200,
      );
      return response;
    });
  }

  private async revokeActiveResetTokens(
    manager: EntityManager,
    userId: string,
    revokedAt: Date,
    excludeId?: string,
  ): Promise<string[]> {
    const result = (await manager.query(
      `UPDATE password_reset_tokens
       SET revoked_at=$2
       WHERE user_id=$1
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND ($3::uuid IS NULL OR id<>$3)
       RETURNING id`,
      [userId, revokedAt, excludeId ?? null],
    )) as unknown;
    const rows = this.returningRows<{ id: string }>(result);
    return rows.map((row) => row.id);
  }

  private async revokeSessions(
    manager: EntityManager,
    userId: string,
    revokedAt: Date,
  ): Promise<string[]> {
    const result = (await manager.query(
      `UPDATE admin_sessions
       SET revoked_at=$2
       WHERE user_id=$1 AND revoked_at IS NULL
       RETURNING id`,
      [userId, revokedAt],
    )) as unknown;
    const rows = this.returningRows<{ id: string }>(result);
    return rows.map((row) => row.id);
  }

  private returningRows<T>(result: unknown): T[] {
    if (
      Array.isArray(result) &&
      result.length === 2 &&
      Array.isArray(result[0]) &&
      typeof result[1] === 'number'
    ) {
      return result[0] as T[];
    }
    return result as T[];
  }

  private async scrubResetOutboxes(
    manager: EntityManager,
    resetTokenIds: string[],
    status: 'password_changed' | 'superseded' | 'used',
  ): Promise<void> {
    for (const resetTokenId of resetTokenIds) {
      await manager.query(
        `UPDATE mail_outbox
         SET payload_encrypted=$2,
             status=CASE WHEN status IN ('pending','sending') THEN 'failed' ELSE status END,
             next_attempt_at=NULL,
             updated_at=now()
         WHERE password_reset_token_id=$1`,
        [
          resetTokenId,
          this.crypto.encrypt(JSON.stringify({ passwordResetTokenId: resetTokenId, status })),
        ],
      );
    }
  }

  private async createAuthenticatedSession(
    manager: EntityManager,
    userId: string,
    metadata: RequestMetadata,
  ) {
    const sessionToken = this.crypto.randomToken();
    const csrfToken = this.crypto.randomToken(24);
    const session = manager.create(AdminSessionEntity, {
      userId,
      tokenHash: this.crypto.digest(sessionToken),
      csrfHash: this.crypto.digest(csrfToken),
      kind: 'authenticated',
      expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
      revokedAt: null,
      ipHash: metadata.ip ? this.crypto.digest(metadata.ip) : null,
      userAgent: metadata.userAgent?.slice(0, 512) ?? null,
      mfaFailedAttempts: 0,
      mfaLockedUntil: null,
    });
    await manager.save(AdminSessionEntity, session);
    return { sessionToken, csrfToken };
  }

  private async insertAudit(
    manager: EntityManager,
    actorId: string | null,
    actorRole: string | null,
    requestId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await manager.insert(AuditLogEntity, {
      actorId,
      actorRole,
      action,
      resourceType,
      resourceId,
      requestId,
      beforeDigest: null,
      afterDigest: null,
      metadata: metadata as never,
    });
  }

  private resetRequestAccepted() {
    return { status: 'accepted' as const };
  }

  private secretCommandDigest(operation: string, fields: Record<string, string>): string {
    const canonicalFields = Object.fromEntries(
      Object.entries(fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, this.crypto.digest(value)]),
    );
    return this.crypto.digest(JSON.stringify({ operation, fields: canonicalFields }));
  }

  private async claimPublicReceipt<T>(
    manager: EntityManager,
    operation: string,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<PublicReceiptClaim<T>> {
    const inserted = (await manager.query(
      `INSERT INTO public_command_receipts(operation,idempotency_key,request_digest,state)
       VALUES($1,$2,$3,'pending')
       ON CONFLICT(operation,idempotency_key) DO NOTHING
       RETURNING id`,
      [operation, idempotencyKey, requestDigest],
    )) as Array<{ id: string }>;
    if (inserted.length) return { owner: true, response: null };

    const rows = (await manager.query(
      `SELECT request_digest AS "requestDigest",response_payload AS "responsePayload"
       FROM public_command_receipts
       WHERE operation=$1 AND idempotency_key=$2
       FOR UPDATE`,
      [operation, idempotencyKey],
    )) as Array<{ requestDigest: string; responsePayload: T | null }>;
    const receipt = rows[0];
    if (!receipt) {
      throw new AppException(409, 'IDEMPOTENCY_RACE', 'Không thể xác nhận idempotency receipt.');
    }
    if (receipt.requestDigest !== requestDigest) {
      throw new AppException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key đã được dùng với payload khác.',
      );
    }
    return { owner: false, response: receipt.responsePayload };
  }

  private async completePublicReceipt<T>(
    manager: EntityManager,
    operation: string,
    idempotencyKey: string,
    response: T,
    statusCode: number,
  ): Promise<void> {
    await manager.query(
      `UPDATE public_command_receipts
       SET state='completed',response_payload=$3::jsonb,status_code=$4,updated_at=now()
       WHERE operation=$1 AND idempotency_key=$2`,
      [operation, idempotencyKey, JSON.stringify(response), statusCode],
    );
  }

  private async enforceMinimumDuration(startedAt: number, minimumMs: number): Promise<void> {
    const remaining = minimumMs - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  private throwInvalidPasswordReset(): never {
    throw new AppException(
      400,
      'PASSWORD_RESET_INVALID_OR_EXPIRED',
      'Yêu cầu đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.',
    );
  }

  private replayed<T>(response: T | null): T {
    if (response) return response;
    throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
  }

  private toPrincipal(user: UserEntity) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      mfaEnabled: user.mfaEnabled,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
