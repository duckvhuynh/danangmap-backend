import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, IsNull } from 'typeorm';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { UserRole, UserStatus } from '../domain/enums';
import type {
  AdminReasonDto,
  ListInvitesQueryDto,
  ListUsersQueryDto,
  ResendInviteDto,
  UpdateUserDto,
} from './auth.dto';
import {
  AdminSessionEntity,
  AuditLogEntity,
  InviteEntity,
  MailOutboxEntity,
  PasswordResetTokenEntity,
  UserEntity,
  UserMfaMethodEntity,
  UserMfaRecoveryCodeEntity,
} from './identity.entities';
import { identityEtag } from './identity-etag';
import { IdentityRateLimitService } from './identity-rate-limit.service';

interface PageCursor {
  createdAt: string;
  id: string;
}

interface MutationResult<T> {
  data: T;
  etag: string;
}

interface UserDirectoryRow {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: Date | string | null;
  disabledAt: Date | string | null;
  lockVersion: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  activeSessionCount: number;
  latestSessionCreatedAt: Date | string | null;
  recoveryCodesRemaining: number;
  pendingInviteCount: number;
  pendingPasswordReset: boolean;
}

interface InviteDirectoryRow {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: UserRole;
  expiresAt: Date | string;
  usedAt: Date | string | null;
  revokedAt: Date | string | null;
  acceptedUserId: string | null;
  supersedesInviteId: string | null;
  lockVersion: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  mailStatus: string | null;
}

@Injectable()
export class AdminIdentityService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly crypto: CryptoService,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimits: IdentityRateLimitService,
    private readonly config: ConfigService,
  ) {}

  async listUsers(query: ListUsersQueryDto) {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    const parameters: unknown[] = [];
    const where: string[] = [];
    const parameter = (value: unknown) => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    if (query.q) {
      const search = parameter(`%${query.q.trim().toLowerCase()}%`);
      where.push(`(
        lower(unaccent(u.email)) LIKE lower(unaccent(${search}))
        OR lower(unaccent(u.username)) LIKE lower(unaccent(${search}))
        OR lower(unaccent(u.display_name)) LIKE lower(unaccent(${search}))
      )`);
    }
    if (query.role) where.push(`u.role=${parameter(query.role)}`);
    if (query.status) where.push(`u.status=${parameter(query.status)}`);
    if (cursor) {
      where.push(
        `(u.created_at,u.id)<(${parameter(cursor.createdAt)}::timestamptz,${parameter(cursor.id)}::uuid)`,
      );
    }
    const limit = query.limit ?? 50;
    const rows = (await this.dataSource.query(
      `SELECT u.id,u.email,u.username,u.display_name AS "displayName",u.role,u.status,
              u.mfa_enabled AS "mfaEnabled",u.must_change_password AS "mustChangePassword",
              u.failed_login_count AS "failedLoginCount",u.locked_until AS "lockedUntil",
              u.disabled_at AS "disabledAt",u.lock_version AS "lockVersion",
              u.created_at AS "createdAt",u.updated_at AS "updatedAt",
              COALESCE(s.active_count,0)::integer AS "activeSessionCount",
              s.latest_created_at AS "latestSessionCreatedAt",
              COALESCE(r.remaining,0)::integer AS "recoveryCodesRemaining",
              COALESCE(i.pending_count,0)::integer AS "pendingInviteCount",
              COALESCE(p.pending,false) AS "pendingPasswordReset"
       FROM users u
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS active_count,max(created_at) AS latest_created_at
         FROM admin_sessions
         WHERE user_id=u.id AND revoked_at IS NULL AND expires_at>now()
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS remaining
         FROM user_mfa_recovery_codes
         WHERE user_id=u.id AND consumed_at IS NULL
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::integer AS pending_count
         FROM invites
         WHERE lower(email)=u.email_normalized AND used_at IS NULL
           AND revoked_at IS NULL AND expires_at>now()
       ) i ON true
       LEFT JOIN LATERAL (
         SELECT true AS pending
         FROM password_reset_tokens
         WHERE user_id=u.id AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now()
         LIMIT 1
       ) p ON true
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY u.created_at DESC,u.id DESC
       LIMIT ${parameter(limit + 1)}`,
      parameters,
    )) as UserDirectoryRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => this.userListItem(row)),
      meta: {
        nextCursor:
          hasMore && last
            ? this.encodeCursor({ createdAt: this.iso(last.createdAt), id: last.id })
            : null,
        hasMore,
        limit,
      },
    };
  }

  async getUser(userId: string): Promise<MutationResult<Record<string, unknown>>> {
    const data = await this.loadUserDetail(this.dataSource.manager, userId);
    return { data, etag: String(data.etag) };
  }

  async updateUser(
    userId: string,
    dto: UpdateUserDto,
    expectedVersion: number,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
    ip?: string,
  ): Promise<MutationResult<Record<string, unknown>>> {
    if (
      dto.displayName === undefined &&
      dto.role === undefined &&
      dto.status === undefined &&
      dto.unlock !== true
    ) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Cần ít nhất một thay đổi tài khoản.');
    }
    if ((dto.role !== undefined || dto.status !== undefined) && !dto.reason?.trim()) {
      throw new AppException(
        422,
        'VALIDATION_FAILED',
        'Lý do là bắt buộc khi thay đổi vai trò hoặc trạng thái.',
      );
    }
    const requestDigest = this.idempotency.digest({ userId, expectedVersion, dto });
    return this.dataSource.transaction(async (manager) => {
      const operation = `admin.user.update.${userId}`;
      const claim = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        actorId,
        operation,
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) {
        const data = this.replayed(claim.response);
        return { data, etag: claim.etag ?? String(data.etag) };
      }

      await this.rateLimits.enforceAdminMutation(ip, actorId);

      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        'identity.system-admin-quorum',
      ]);
      const user = await this.lockUser(manager, userId);
      this.assertVersion('user', user.id, user.lockVersion, expectedVersion);
      const nextRole = dto.role ?? user.role;
      const nextStatus = dto.status ?? user.status;
      const unsafeSelfMutation =
        actorId === userId &&
        ((dto.role !== undefined && nextRole !== 'system_admin') ||
          (dto.status !== undefined && nextStatus !== 'active'));
      if (unsafeSelfMutation) this.throwSelfSecurityMutation();
      await this.assertSystemAdminQuorum(manager, user, nextRole, nextStatus);
      if (nextStatus === 'active' && !user.passwordHash) {
        throw new AppException(
          422,
          'USER_PASSWORD_REQUIRED',
          'Tài khoản chưa có mật khẩu và không thể kích hoạt trực tiếp.',
        );
      }

      const before = { role: user.role, status: user.status, displayName: user.displayName };
      const roleChanged = nextRole !== user.role;
      const statusChanged = nextStatus !== user.status;
      const displayName = dto.displayName?.trim() ?? user.displayName;
      const displayNameChanged = displayName !== user.displayName;
      const unlocked =
        dto.unlock === true && (user.failedLoginCount > 0 || user.lockedUntil !== null);
      const securityChanged = roleChanged || statusChanged;
      user.displayName = displayName;
      user.role = nextRole;
      user.status = nextStatus;
      if (nextStatus === 'disabled') user.disabledAt = user.disabledAt ?? new Date();
      if (nextStatus === 'active') user.disabledAt = null;
      if (unlocked || (statusChanged && nextStatus === 'active')) {
        user.failedLoginCount = 0;
        user.lockedUntil = null;
      }
      let sessionsRevoked = 0;
      if (securityChanged) sessionsRevoked = await this.revokeActiveSessions(manager, user.id);
      if (securityChanged || displayNameChanged || unlocked) user.lockVersion += 1;
      await manager.save(UserEntity, user);

      if (securityChanged || displayNameChanged || unlocked) {
        await this.insertAudit(
          manager,
          actorId,
          actorRole,
          requestId,
          'user.updated',
          'user',
          user.id,
          {
            fields: [
              ...(displayNameChanged ? ['displayName'] : []),
              ...(roleChanged ? ['role'] : []),
              ...(statusChanged ? ['status'] : []),
              ...(unlocked ? ['lock'] : []),
            ],
            beforeRole: before.role,
            afterRole: user.role,
            beforeStatus: before.status,
            afterStatus: user.status,
            reason: dto.reason?.trim() ?? null,
            sessionsRevoked,
          },
        );
      }
      const data = await this.loadUserDetail(manager, user.id);
      const etag = identityEtag('user', user.id, user.lockVersion);
      await this.idempotency.complete(manager, actorId, operation, idempotencyKey, data, 200, etag);
      return { data, etag };
    });
  }

  async revokeSession(
    userId: string,
    sessionId: string,
    dto: AdminReasonDto,
    expectedVersion: number,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
    ip?: string,
  ) {
    return this.sessionCommand(
      userId,
      dto,
      expectedVersion,
      actorId,
      actorRole,
      requestId,
      idempotencyKey,
      sessionId,
      ip,
    );
  }

  async revokeAllUserSessions(
    userId: string,
    dto: AdminReasonDto,
    expectedVersion: number,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
    ip?: string,
  ) {
    return this.sessionCommand(
      userId,
      dto,
      expectedVersion,
      actorId,
      actorRole,
      requestId,
      idempotencyKey,
      null,
      ip,
    );
  }

  async resetMfa(
    userId: string,
    dto: AdminReasonDto,
    expectedVersion: number,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
    ip?: string,
  ) {
    if (!(this.config.get<boolean>('app.mfaEnabled') ?? false)) {
      throw new AppException(409, 'MFA_DISABLED', 'Xác thực đa yếu tố đang được tắt.');
    }
    if (actorId === userId) this.throwSelfSecurityMutation();
    const requestDigest = this.idempotency.digest({ userId, expectedVersion, dto });
    return this.dataSource.transaction(async (manager) => {
      const operation = `admin.user.mfa-reset.${userId}`;
      const claim = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        actorId,
        operation,
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) {
        const data = this.replayed(claim.response);
        return { data, etag: claim.etag ?? String(data.etag) };
      }
      await this.rateLimits.enforceAdminMutation(ip, actorId);
      const user = await this.lockUser(manager, userId);
      this.assertVersion('user', user.id, user.lockVersion, expectedVersion);
      const methodCount = await manager.count(UserMfaMethodEntity, { where: { userId } });
      if (!user.mfaEnabled && methodCount === 0) {
        throw new AppException(409, 'USER_MFA_NOT_ENROLLED', 'Tài khoản chưa đăng ký MFA.');
      }
      const recoveryCodesRevoked = await manager.count(UserMfaRecoveryCodeEntity, {
        where: { userId, consumedAt: IsNull() },
      });
      const sessionsRevoked = await this.revokeActiveSessions(manager, userId);
      await manager.delete(UserMfaRecoveryCodeEntity, { userId });
      await manager.delete(UserMfaMethodEntity, { userId });
      user.mfaEnabled = false;
      user.mfaSecretEncrypted = null;
      user.lockVersion += 1;
      await manager.save(UserEntity, user);
      const data = {
        userId,
        status: 'mfa_reset',
        mfaEnrollmentRequired: true,
        sessionsRevoked,
        etag: identityEtag('user', userId, user.lockVersion),
      };
      await this.insertAudit(
        manager,
        actorId,
        actorRole,
        requestId,
        'user.mfa_reset',
        'user',
        userId,
        {
          reason: dto.reason.trim(),
          sessionsRevoked,
          recoveryCodesRevoked,
        },
      );
      await this.idempotency.complete(
        manager,
        actorId,
        operation,
        idempotencyKey,
        data,
        200,
        data.etag,
      );
      return { data, etag: data.etag };
    });
  }

  async requestPasswordReset(
    userId: string,
    dto: AdminReasonDto,
    expectedVersion: number,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
    ip?: string,
  ) {
    if (actorId === userId) this.throwSelfSecurityMutation();
    const requestDigest = this.idempotency.digest({ userId, expectedVersion, dto });
    return this.dataSource.transaction(async (manager) => {
      const operation = `admin.user.password-reset.${userId}`;
      const claim = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        actorId,
        operation,
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) {
        const data = this.replayed(claim.response);
        return { data, etag: claim.etag ?? String(data.etag) };
      }
      await this.rateLimits.enforceAdminMutation(ip, actorId);
      await this.rateLimits.enforceAdminCredentialDelivery(ip, actorId, userId);
      const user = await this.lockUser(manager, userId);
      this.assertVersion('user', user.id, user.lockVersion, expectedVersion);
      if (user.status !== 'active' || user.disabledAt) {
        throw new AppException(
          409,
          'USER_NOT_ACTIVE',
          'Tài khoản phải hoạt động để đặt lại mật khẩu.',
        );
      }
      const now = new Date();
      const supersededIds = await this.revokeActiveResetTokens(manager, userId, now);
      await this.scrubResetOutboxes(manager, supersededIds);
      const resetTokenId = randomUUID();
      const rawToken = this.crypto.randomToken();
      const expiresAt = new Date(now.getTime() + 30 * 60_000);
      await manager.insert(PasswordResetTokenEntity, {
        id: resetTokenId,
        userId,
        tokenHash: this.crypto.digest(rawToken),
        expiresAt,
        usedAt: null,
        revokedAt: null,
        ipHash: null,
        userAgent: null,
      });
      const outbox = await manager.save(MailOutboxEntity, {
        templateKey: 'identity.password-reset',
        recipientEmail: user.email,
        inviteId: null,
        passwordResetTokenId: resetTokenId,
        payloadEncrypted: this.crypto.encrypt(
          JSON.stringify({ passwordResetTokenId: resetTokenId, token: rawToken }),
        ),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        correlationId: requestId,
      });
      user.lockVersion += 1;
      await manager.save(UserEntity, user);
      const etag = identityEtag('user', user.id, user.lockVersion);
      const data = {
        userId,
        status: 'accepted',
        deliveryStatus: 'pending',
        expiresAt: expiresAt.toISOString(),
        mailOutboxId: outbox.id,
        etag,
      };
      await this.insertAudit(
        manager,
        actorId,
        actorRole,
        requestId,
        'user.password_reset_requested',
        'user',
        user.id,
        {
          reason: dto.reason.trim(),
          supersededRequests: supersededIds.length,
          deliveryStatus: 'pending',
        },
      );
      await this.idempotency.complete(manager, actorId, operation, idempotencyKey, data, 202, etag);
      return { data, etag };
    });
  }

  async listInvites(query: ListInvitesQueryDto) {
    const cursor = query.cursor ? this.decodeCursor(query.cursor) : null;
    const parameters: unknown[] = [];
    const where: string[] = [];
    const parameter = (value: unknown) => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    if (query.q) {
      const search = parameter(`%${query.q.trim().toLowerCase()}%`);
      where.push(`(
        lower(unaccent(i.email)) LIKE lower(unaccent(${search}))
        OR lower(unaccent(i.username)) LIKE lower(unaccent(${search}))
        OR lower(unaccent(i.display_name)) LIKE lower(unaccent(${search}))
      )`);
    }
    if (query.role) where.push(`i.role=${parameter(query.role)}`);
    if (query.status) {
      const status = parameter(query.status);
      where.push(`(
        CASE
          WHEN i.used_at IS NOT NULL THEN 'accepted'
          WHEN i.revoked_at IS NOT NULL THEN 'revoked'
          WHEN i.expires_at<=now() THEN 'expired'
          ELSE 'pending'
        END
      )=${status}`);
    }
    if (cursor) {
      where.push(
        `(i.created_at,i.id)<(${parameter(cursor.createdAt)}::timestamptz,${parameter(cursor.id)}::uuid)`,
      );
    }
    const limit = query.limit ?? 50;
    const rows = (await this.dataSource.query(
      `SELECT i.id,i.email,i.username,i.display_name AS "displayName",i.role,
              i.expires_at AS "expiresAt",i.used_at AS "usedAt",i.revoked_at AS "revokedAt",
              i.accepted_user_id AS "acceptedUserId",
              i.supersedes_invite_id AS "supersedesInviteId",
              i.lock_version AS "lockVersion",i.created_at AS "createdAt",
              i.updated_at AS "updatedAt",mail.status AS "mailStatus"
       FROM invites i
       LEFT JOIN LATERAL (
         SELECT status FROM mail_outbox WHERE invite_id=i.id ORDER BY created_at DESC,id DESC LIMIT 1
       ) mail ON true
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY i.created_at DESC,i.id DESC
       LIMIT ${parameter(limit + 1)}`,
      parameters,
    )) as InviteDirectoryRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => this.inviteItem(row)),
      meta: {
        nextCursor:
          hasMore && last
            ? this.encodeCursor({ createdAt: this.iso(last.createdAt), id: last.id })
            : null,
        hasMore,
        limit,
      },
    };
  }

  async resendInvite(
    inviteId: string,
    dto: ResendInviteDto,
    expectedVersion: number,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
    ip?: string,
  ) {
    const requestDigest = this.idempotency.digest({ inviteId, expectedVersion, dto });
    return this.dataSource.transaction(async (manager) => {
      const operation = `admin.invite.resend.${inviteId}`;
      const claim = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        actorId,
        operation,
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) {
        const data = this.replayed(claim.response);
        return { data, etag: claim.etag ?? String(data.etag) };
      }
      await this.rateLimits.enforceAdminMutation(ip, actorId);
      await this.rateLimits.enforceAdminCredentialDelivery(ip, actorId, inviteId);
      const invite = await manager.findOne(InviteEntity, {
        where: { id: inviteId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!invite) throw new AppException(404, 'INVITE_NOT_FOUND', 'Không tìm thấy lời mời.');
      this.assertVersion('invite', invite.id, invite.lockVersion, expectedVersion);
      if (invite.usedAt || invite.revokedAt) {
        throw new AppException(409, 'INVITE_NOT_RESENDABLE', 'Lời mời không thể gửi lại.');
      }
      const conflictingUsers = (await manager.query(
        `SELECT id FROM users
         WHERE email_normalized=lower($1) OR username_normalized=lower($2)
         LIMIT 1`,
        [invite.email, invite.username],
      )) as Array<{ id: string }>;
      if (conflictingUsers.length) {
        throw new AppException(
          409,
          'INVITE_IDENTITY_CONFLICT',
          'Email hoặc tên đăng nhập đã thuộc một tài khoản nội bộ.',
        );
      }
      const now = new Date();
      invite.revokedAt = now;
      invite.lockVersion += 1;
      await manager.save(InviteEntity, invite);
      await this.scrubInviteOutbox(manager, invite.id);

      const rawToken = this.crypto.randomToken();
      const expiresAt = new Date(now.getTime() + (dto.expiresInHours ?? 72) * 60 * 60_000);
      const replacement = await manager.save(InviteEntity, {
        email: invite.email,
        username: invite.username,
        displayName: invite.displayName,
        role: invite.role,
        tokenHash: this.crypto.digest(rawToken),
        createdBy: actorId,
        expiresAt,
        usedAt: null,
        revokedAt: null,
        acceptedUserId: null,
        supersedesInviteId: invite.id,
        lockVersion: 1,
      });
      await manager.insert(MailOutboxEntity, {
        templateKey: 'identity.invite',
        recipientEmail: replacement.email,
        inviteId: replacement.id,
        passwordResetTokenId: null,
        payloadEncrypted: this.crypto.encrypt(
          JSON.stringify({ inviteId: replacement.id, token: rawToken }),
        ),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        correlationId: requestId,
      });
      const etag = identityEtag('invite', replacement.id, replacement.lockVersion);
      const data = {
        id: replacement.id,
        email: replacement.email,
        username: replacement.username,
        displayName: replacement.displayName,
        role: replacement.role,
        status: 'pending',
        expiresAt: replacement.expiresAt.toISOString(),
        supersedesInviteId: invite.id,
        mailStatus: 'pending',
        lockVersion: replacement.lockVersion,
        etag,
      };
      await this.insertAudit(
        manager,
        actorId,
        actorRole,
        requestId,
        'invite.resend_requested',
        'invite',
        invite.id,
        {
          replacementInviteId: replacement.id,
          reason: dto.reason.trim(),
          expiresAt: replacement.expiresAt.toISOString(),
        },
      );
      await this.idempotency.complete(manager, actorId, operation, idempotencyKey, data, 202, etag);
      return { data, etag };
    });
  }

  private async sessionCommand(
    userId: string,
    dto: AdminReasonDto,
    expectedVersion: number,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
    sessionId: string | null,
    ip?: string,
  ) {
    if (actorId === userId) this.throwSelfSecurityMutation();
    const scope = sessionId ? 'one' : 'all';
    const requestDigest = this.idempotency.digest({
      userId,
      sessionId,
      expectedVersion,
      dto,
    });
    return this.dataSource.transaction(async (manager) => {
      const operation = `admin.user.sessions-revoke-${scope}.${userId}`;
      const claim = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        actorId,
        operation,
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) {
        const data = this.replayed(claim.response);
        return { data, etag: claim.etag ?? String(data.etag) };
      }
      await this.rateLimits.enforceAdminMutation(ip, actorId);
      const user = await this.lockUser(manager, userId);
      this.assertVersion('user', user.id, user.lockVersion, expectedVersion);
      let revokedCount: number;
      if (sessionId) {
        const sessions = (await manager.query(
          `SELECT id,revoked_at,expires_at FROM admin_sessions
           WHERE id=$1 AND user_id=$2 FOR UPDATE`,
          [sessionId, userId],
        )) as Array<{ id: string; revoked_at: Date | null; expires_at: Date }>;
        const session = sessions[0];
        if (!session) {
          throw new AppException(404, 'USER_SESSION_NOT_FOUND', 'Không tìm thấy phiên đăng nhập.');
        }
        if (session.revoked_at || new Date(session.expires_at) <= new Date()) {
          throw new AppException(
            409,
            'USER_SESSION_NOT_ACTIVE',
            'Phiên đăng nhập không còn hoạt động.',
          );
        }
        await manager.update(AdminSessionEntity, sessionId, { revokedAt: new Date() });
        revokedCount = 1;
      } else {
        revokedCount = await this.revokeActiveSessions(manager, userId);
      }
      if (revokedCount === 0) {
        throw new AppException(
          409,
          'USER_SESSION_NOT_ACTIVE',
          'Tài khoản không có phiên hoạt động.',
        );
      }
      user.lockVersion += 1;
      await manager.save(UserEntity, user);
      const etag = identityEtag('user', user.id, user.lockVersion);
      const data = {
        userId,
        status: 'sessions_revoked',
        scope,
        sessionId,
        revokedCount,
        etag,
      };
      await this.insertAudit(
        manager,
        actorId,
        actorRole,
        requestId,
        sessionId ? 'user.session_revoked' : 'user.sessions_revoked_all',
        'user',
        user.id,
        {
          reason: dto.reason.trim(),
          sessionId,
          revokedCount,
        },
      );
      await this.idempotency.complete(manager, actorId, operation, idempotencyKey, data, 200, etag);
      return { data, etag };
    });
  }

  private async loadUserDetail(
    manager: EntityManager,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const users = (await manager.query(
      `SELECT id,email,username,display_name AS "displayName",role,status,
              mfa_enabled AS "mfaEnabled",must_change_password AS "mustChangePassword",
              failed_login_count AS "failedLoginCount",locked_until AS "lockedUntil",
              disabled_at AS "disabledAt",lock_version AS "lockVersion",
              created_at AS "createdAt",updated_at AS "updatedAt"
       FROM users WHERE id=$1`,
      [userId],
    )) as UserDirectoryRow[];
    const user = users[0];
    if (!user) throw new AppException(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản.');
    const [sessions, methods, recovery, invites, passwordResets] = await Promise.all([
      manager.query(
        `SELECT id,kind,expires_at AS "expiresAt",revoked_at AS "revokedAt",
                user_agent AS "userAgent",created_at AS "createdAt"
         FROM admin_sessions WHERE user_id=$1
         ORDER BY created_at DESC,id DESC LIMIT 50`,
        [userId],
      ) as Promise<
        Array<{
          id: string;
          kind: string;
          expiresAt: Date | string;
          revokedAt: Date | string | null;
          userAgent: string | null;
          createdAt: Date | string;
        }>
      >,
      manager.query(
        `SELECT status,verified_at AS "verifiedAt",created_at AS "createdAt",
                updated_at AS "updatedAt"
         FROM user_mfa_methods WHERE user_id=$1 LIMIT 1`,
        [userId],
      ) as Promise<
        Array<{
          status: string;
          verifiedAt: Date | string | null;
          createdAt: Date | string;
          updatedAt: Date | string;
        }>
      >,
      manager.query(
        `SELECT count(*) FILTER (WHERE consumed_at IS NULL)::integer AS remaining,
                count(*) FILTER (WHERE consumed_at IS NOT NULL)::integer AS consumed
         FROM user_mfa_recovery_codes WHERE user_id=$1`,
        [userId],
      ) as Promise<Array<{ remaining: number; consumed: number }>>,
      manager.query(
        `SELECT i.id,i.expires_at AS "expiresAt",i.used_at AS "usedAt",
                i.revoked_at AS "revokedAt",i.created_at AS "createdAt",
                i.lock_version AS "lockVersion",mail.status AS "mailStatus"
         FROM invites i
         LEFT JOIN LATERAL (
           SELECT status FROM mail_outbox WHERE invite_id=i.id ORDER BY created_at DESC,id DESC LIMIT 1
         ) mail ON true
         WHERE lower(i.email)=$1
         ORDER BY i.created_at DESC,i.id DESC LIMIT 20`,
        [user.email.toLowerCase()],
      ) as Promise<
        Array<{
          id: string;
          expiresAt: Date | string;
          usedAt: Date | string | null;
          revokedAt: Date | string | null;
          createdAt: Date | string;
          lockVersion: number;
          mailStatus: string | null;
        }>
      >,
      manager.query(
        `SELECT pr.id,pr.expires_at AS "expiresAt",pr.used_at AS "usedAt",
                pr.revoked_at AS "revokedAt",pr.created_at AS "createdAt",mail.status AS "mailStatus"
         FROM password_reset_tokens pr
         LEFT JOIN LATERAL (
           SELECT status FROM mail_outbox WHERE password_reset_token_id=pr.id
           ORDER BY created_at DESC,id DESC LIMIT 1
         ) mail ON true
         WHERE pr.user_id=$1 ORDER BY pr.created_at DESC,pr.id DESC LIMIT 10`,
        [userId],
      ) as Promise<
        Array<{
          id: string;
          expiresAt: Date | string;
          usedAt: Date | string | null;
          revokedAt: Date | string | null;
          createdAt: Date | string;
          mailStatus: string | null;
        }>
      >,
    ]);
    const now = Date.now();
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      disabledAt: this.isoOrNull(user.disabledAt),
      lockedUntil: this.isoOrNull(user.lockedUntil),
      failedLoginCount: user.failedLoginCount,
      lockVersion: user.lockVersion,
      etag: identityEtag('user', user.id, user.lockVersion),
      createdAt: this.iso(user.createdAt),
      updatedAt: this.iso(user.updatedAt),
      mfa: {
        enabled: user.mfaEnabled,
        status: methods[0]?.status ?? 'not_enrolled',
        verifiedAt: this.isoOrNull(methods[0]?.verifiedAt ?? null),
        recoveryCodesRemaining: Number(recovery[0]?.remaining ?? 0),
        recoveryCodesConsumed: Number(recovery[0]?.consumed ?? 0),
      },
      sessions: sessions.map((session) => ({
        id: session.id,
        kind: session.kind,
        status: session.revokedAt
          ? 'revoked'
          : new Date(session.expiresAt).getTime() <= now
            ? 'expired'
            : 'active',
        createdAt: this.iso(session.createdAt),
        expiresAt: this.iso(session.expiresAt),
        revokedAt: this.isoOrNull(session.revokedAt),
        userAgent: session.userAgent,
      })),
      invites: invites.map((invite) => ({
        id: invite.id,
        status: this.inviteStatus(invite),
        expiresAt: this.iso(invite.expiresAt),
        createdAt: this.iso(invite.createdAt),
        mailStatus: invite.mailStatus,
        etag: identityEtag('invite', invite.id, invite.lockVersion),
      })),
      passwordResets: passwordResets.map((reset) => ({
        id: reset.id,
        status: reset.usedAt
          ? 'used'
          : reset.revokedAt
            ? 'revoked'
            : new Date(reset.expiresAt).getTime() <= now
              ? 'expired'
              : 'pending',
        expiresAt: this.iso(reset.expiresAt),
        createdAt: this.iso(reset.createdAt),
        mailStatus: reset.mailStatus,
      })),
    };
  }

  private userListItem(row: UserDirectoryRow) {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      status: row.status,
      mfaEnabled: row.mfaEnabled,
      mustChangePassword: row.mustChangePassword,
      disabledAt: this.isoOrNull(row.disabledAt),
      lockedUntil: this.isoOrNull(row.lockedUntil),
      lockVersion: row.lockVersion,
      etag: identityEtag('user', row.id, row.lockVersion),
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
      security: {
        activeSessionCount: Number(row.activeSessionCount),
        latestSessionCreatedAt: this.isoOrNull(row.latestSessionCreatedAt),
        recoveryCodesRemaining: Number(row.recoveryCodesRemaining),
        pendingInviteCount: Number(row.pendingInviteCount),
        pendingPasswordReset: Boolean(row.pendingPasswordReset),
      },
    };
  }

  private inviteItem(row: InviteDirectoryRow) {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      status: this.inviteStatus(row),
      expiresAt: this.iso(row.expiresAt),
      usedAt: this.isoOrNull(row.usedAt),
      revokedAt: this.isoOrNull(row.revokedAt),
      acceptedUserId: row.acceptedUserId,
      supersedesInviteId: row.supersedesInviteId,
      mailStatus: row.mailStatus,
      lockVersion: row.lockVersion,
      etag: identityEtag('invite', row.id, row.lockVersion),
      createdAt: this.iso(row.createdAt),
      updatedAt: this.iso(row.updatedAt),
    };
  }

  private inviteStatus(invite: {
    usedAt: Date | string | null;
    revokedAt: Date | string | null;
    expiresAt: Date | string;
  }): 'accepted' | 'revoked' | 'expired' | 'pending' {
    if (invite.usedAt) return 'accepted';
    if (invite.revokedAt) return 'revoked';
    if (new Date(invite.expiresAt).getTime() <= Date.now()) return 'expired';
    return 'pending';
  }

  private async lockUser(manager: EntityManager, userId: string): Promise<UserEntity> {
    const user = await manager.findOne(UserEntity, {
      where: { id: userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!user) throw new AppException(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản.');
    return user;
  }

  private assertVersion(
    resource: 'user' | 'invite',
    resourceId: string,
    current: number,
    expected: number,
  ): void {
    if (current === expected) return;
    throw new AppException(412, 'ETAG_MISMATCH', 'Dữ liệu đã thay đổi.', {
      currentEtag: identityEtag(resource, resourceId, current),
    });
  }

  private async assertSystemAdminQuorum(
    manager: EntityManager,
    user: UserEntity,
    nextRole: UserRole,
    nextStatus: UserStatus,
  ): Promise<void> {
    const removesActiveSystemAdmin =
      user.role === 'system_admin' &&
      user.status === 'active' &&
      !user.disabledAt &&
      (nextRole !== 'system_admin' || nextStatus !== 'active');
    if (!removesActiveSystemAdmin) return;
    const rows = (await manager.query(
      `SELECT count(*)::integer AS count FROM users
       WHERE id<>$1 AND role='system_admin' AND status='active' AND disabled_at IS NULL`,
      [user.id],
    )) as Array<{ count: number }>;
    if ((rows[0]?.count ?? 0) > 0) return;
    throw new AppException(
      409,
      'LAST_SYSTEM_ADMIN_REQUIRED',
      'Hệ thống phải còn ít nhất một System Admin đang hoạt động.',
    );
  }

  private async revokeActiveSessions(manager: EntityManager, userId: string): Promise<number> {
    const result = (await manager.query(
      `UPDATE admin_sessions SET revoked_at=now()
       WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
       RETURNING id`,
      [userId],
    )) as unknown;
    return this.returningRows<{ id: string }>(result).length;
  }

  private async revokeActiveResetTokens(
    manager: EntityManager,
    userId: string,
    revokedAt: Date,
  ): Promise<string[]> {
    const result = (await manager.query(
      `UPDATE password_reset_tokens SET revoked_at=$2
       WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL
       RETURNING id`,
      [userId, revokedAt],
    )) as unknown;
    return this.returningRows<{ id: string }>(result).map((row) => row.id);
  }

  private async scrubResetOutboxes(manager: EntityManager, resetTokenIds: string[]): Promise<void> {
    if (resetTokenIds.length === 0) return;
    await manager.query(
      `UPDATE mail_outbox
       SET payload_encrypted=NULL,payload_scrubbed_at=COALESCE(payload_scrubbed_at,now()),
           status=CASE WHEN status IN ('pending','claimed','sending','failed') THEN 'cancelled' ELSE status END,
           claim_token=NULL,claimed_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
           last_error_code=CASE WHEN status IN ('pending','claimed','sending','failed')
             THEN 'MAIL_CREDENTIAL_INVALID' ELSE last_error_code END,
           updated_at=now()
       WHERE password_reset_token_id=ANY($1::uuid[])`,
      [resetTokenIds],
    );
  }

  private async scrubInviteOutbox(manager: EntityManager, inviteId: string): Promise<void> {
    await manager.query(
      `UPDATE mail_outbox
       SET payload_encrypted=NULL,payload_scrubbed_at=COALESCE(payload_scrubbed_at,now()),
           status=CASE WHEN status IN ('pending','claimed','sending','failed') THEN 'cancelled' ELSE status END,
           claim_token=NULL,claimed_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
           last_error_code=CASE WHEN status IN ('pending','claimed','sending','failed')
             THEN 'MAIL_CREDENTIAL_INVALID' ELSE last_error_code END,
           updated_at=now()
       WHERE invite_id=$1`,
      [inviteId],
    );
  }

  private async insertAudit(
    manager: EntityManager,
    actorId: string,
    actorRole: string,
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

  private encodeCursor(value: PageCursor): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  private decodeCursor(value: string): PageCursor {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid');
      const decoded = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<PageCursor>;
      if (
        typeof decoded.createdAt !== 'string' ||
        Number.isNaN(Date.parse(decoded.createdAt)) ||
        typeof decoded.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          decoded.id,
        )
      ) {
        throw new Error('invalid');
      }
      return { createdAt: decoded.createdAt, id: decoded.id };
    } catch {
      throw new AppException(400, 'VALIDATION_FAILED', 'Cursor không hợp lệ.');
    }
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

  private iso(value: Date | string): string {
    return new Date(value).toISOString();
  }

  private isoOrNull(value: Date | string | null): string | null {
    return value === null ? null : this.iso(value);
  }

  private replayed<T>(response: T | null): T {
    if (response) return response;
    throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
  }

  private throwSelfSecurityMutation(): never {
    throw new AppException(
      409,
      'SELF_SECURITY_MUTATION_FORBIDDEN',
      'Hãy dùng luồng bảo mật tài khoản cá nhân cho chính tài khoản đang đăng nhập.',
    );
  }
}
