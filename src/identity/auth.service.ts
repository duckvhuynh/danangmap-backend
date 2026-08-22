import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { DataSource, type EntityManager, IsNull, QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type {
  AcceptInviteDto,
  CreateInviteDto,
  CreateUserDto,
  InspectInviteDto,
  LoginDto,
  VerifyMfaDto,
} from './auth.dto';
import {
  AdminSessionEntity,
  InviteEntity,
  MailOutboxEntity,
  UserMfaMethodEntity,
  UserMfaRecoveryCodeEntity,
  UserEntity,
} from './identity.entities';
import { IdentityRateLimitService } from './identity-rate-limit.service';

interface RequestMetadata {
  requestId: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(AdminSessionEntity) private readonly sessions: Repository<AdminSessionEntity>,
    @InjectRepository(InviteEntity) private readonly invites: Repository<InviteEntity>,
    @InjectRepository(MailOutboxEntity) private readonly mailOutbox: Repository<MailOutboxEntity>,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimits: IdentityRateLimitService,
  ) {}

  async login(dto: LoginDto, metadata: RequestMetadata) {
    const normalized = dto.login.trim().toLowerCase();
    const user = await this.users.findOne({
      where: [{ emailNormalized: normalized }, { usernameNormalized: normalized }],
    });
    const hash = user?.passwordHash ?? '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$X';
    const passwordValid = await argon2.verify(hash, dto.password).catch(() => false);
    if (!user || !passwordValid || user.status !== 'active' || user.disabledAt) {
      if (user && user.status === 'active') await this.recordFailedLogin(user);
      throw new AppException(401, 'AUTH_INVALID_CREDENTIALS', 'Thông tin đăng nhập không hợp lệ.');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppException(401, 'AUTH_INVALID_CREDENTIALS', 'Thông tin đăng nhập không hợp lệ.');
    }
    await this.users.update(user.id, { failedLoginCount: 0, lockedUntil: null });
    const token = this.crypto.randomToken();
    const csrfToken = this.crypto.randomToken(24);
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await this.sessions.insert({
      userId: user.id,
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
    await this.audit.append({
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.password_verified',
      resourceType: 'user',
      resourceId: user.id,
      requestId: metadata.requestId,
    });
    return {
      token,
      csrfToken,
      data: {
        status: 'mfa_required',
        mfaEnrollmentRequired: !user.mfaEnabled,
        challengeExpiresAt: expiresAt.toISOString(),
      },
    };
  }

  async verifyMfa(
    userId: string,
    preauthSessionId: string,
    method: VerifyMfaDto['method'],
    code: string,
    metadata: RequestMetadata,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      await this.lockActivePreauth(manager, preauthSessionId, userId);
      const user = await manager.findOne(UserEntity, {
        where: { id: userId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!user?.mfaEnabled) {
        throw new AppException(401, 'AUTH_MFA_REQUIRED', 'Tài khoản cần đăng ký MFA.');
      }

      const valid =
        method === 'recovery_code'
          ? await this.consumeRecoveryCode(manager, userId, code)
          : await this.verifyUserTotp(manager, user, code);
      if (!valid) return this.failedMfaAttempt(manager, preauthSessionId);

      const authenticated = await this.createAuthenticatedSession(manager, userId, metadata);
      await manager.update(AdminSessionEntity, preauthSessionId, { revokedAt: new Date() });
      await this.insertAudit(
        manager,
        user.id,
        user.role,
        metadata.requestId,
        'auth.login_succeeded',
        'admin_session',
        authenticated.session.id,
        { method },
      );
      return {
        ok: true as const,
        sessionToken: authenticated.sessionToken,
        csrfToken: authenticated.csrfToken,
        principal: this.toPrincipal(user),
      };
    });
    if (!result.ok) this.throwInvalidMfa(result.rateLimited);
    return result;
  }

  async startMfaEnrollment(userId: string, preauthSessionId: string, metadata: RequestMetadata) {
    return this.dataSource.transaction(async (manager) => {
      await this.lockActivePreauth(manager, preauthSessionId, userId);
      const user = await manager.findOne(UserEntity, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user || user.status !== 'active' || user.disabledAt) {
        throw new AppException(401, 'AUTH_SESSION_EXPIRED', 'MFA challenge đã hết hạn.');
      }
      if (user.mfaEnabled) {
        throw new AppException(409, 'AUTH_MFA_ALREADY_ENROLLED', 'Tài khoản đã đăng ký MFA.');
      }
      let method = await manager.findOne(UserMfaMethodEntity, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (method?.status === 'verified') {
        throw new AppException(409, 'AUTH_MFA_ALREADY_ENROLLED', 'Tài khoản đã đăng ký MFA.');
      }
      if (method?.enrollmentSessionId === preauthSessionId) {
        throw new AppException(
          409,
          'AUTH_MFA_ENROLLMENT_ALREADY_STARTED',
          'MFA enrollment URI đã được cấp cho challenge này.',
        );
      }
      if (!method) {
        method = await manager.save(UserMfaMethodEntity, {
          userId,
          status: 'pending',
          secretEncrypted: this.crypto.encrypt(generateSecret()),
          lastUsedTimeStep: null,
          enrollmentSessionId: preauthSessionId,
          verifiedAt: null,
        });
        await this.insertAudit(
          manager,
          user.id,
          user.role,
          metadata.requestId,
          'auth.mfa_enrollment_started',
          'user',
          user.id,
          {},
        );
      } else {
        method.secretEncrypted = this.crypto.encrypt(generateSecret());
        method.lastUsedTimeStep = null;
        method.enrollmentSessionId = preauthSessionId;
        method = await manager.save(UserMfaMethodEntity, method);
        await this.insertAudit(
          manager,
          user.id,
          user.role,
          metadata.requestId,
          'auth.mfa_enrollment_rotated',
          'user',
          user.id,
          {},
        );
      }
      return {
        status: 'pending' as const,
        enrollmentUri: generateURI({
          issuer: this.config.getOrThrow<string>('app.mfaTotpIssuer'),
          label: user.email,
          secret: this.crypto.decrypt(method.secretEncrypted),
        }),
      };
    });
  }

  async confirmMfaEnrollment(
    userId: string,
    preauthSessionId: string,
    code: string,
    metadata: RequestMetadata,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      await this.lockActivePreauth(manager, preauthSessionId, userId);
      const user = await manager.findOne(UserEntity, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user || user.status !== 'active' || user.disabledAt) {
        throw new AppException(401, 'AUTH_SESSION_EXPIRED', 'MFA challenge đã hết hạn.');
      }
      if (user.mfaEnabled) {
        throw new AppException(409, 'AUTH_MFA_ALREADY_ENROLLED', 'Tài khoản đã đăng ký MFA.');
      }
      const method = await manager.findOne(UserMfaMethodEntity, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!method || method.status !== 'pending') {
        throw new AppException(409, 'AUTH_MFA_ENROLLMENT_REQUIRED', 'Hãy bắt đầu đăng ký MFA.');
      }
      if (method.enrollmentSessionId !== preauthSessionId) {
        throw new AppException(
          409,
          'AUTH_MFA_ENROLLMENT_STALE',
          'MFA challenge này không còn là challenge đăng ký hiện hành.',
        );
      }
      const secret = this.crypto.decrypt(method.secretEncrypted);
      const acceptedTimeStep = await this.verifyTotp(secret, code);
      if (acceptedTimeStep === null) {
        return this.failedMfaAttempt(manager, preauthSessionId);
      }

      const now = new Date();
      const rawRecoveryCodes = Array.from({ length: 10 }, () => this.generateRecoveryCode());
      method.status = 'verified';
      method.verifiedAt = now;
      method.lastUsedTimeStep = String(acceptedTimeStep);
      method.enrollmentSessionId = null;
      await manager.save(UserMfaMethodEntity, method);
      user.mfaEnabled = true;
      user.mfaSecretEncrypted = method.secretEncrypted;
      await manager.save(UserEntity, user);
      await manager.delete(UserMfaRecoveryCodeEntity, { userId });
      await manager.insert(
        UserMfaRecoveryCodeEntity,
        rawRecoveryCodes.map((rawCode) => ({
          userId,
          codeDigest: this.crypto.digest(this.normalizeRecoveryCode(rawCode)),
          consumedAt: null,
        })),
      );
      await manager.update(AdminSessionEntity, { userId, revokedAt: IsNull() }, { revokedAt: now });
      const authenticated = await this.createAuthenticatedSession(manager, userId, metadata);
      await this.insertAudit(
        manager,
        user.id,
        user.role,
        metadata.requestId,
        'auth.mfa_enrollment_confirmed',
        'user',
        user.id,
        { recoveryCodeCount: rawRecoveryCodes.length },
      );
      await this.insertAudit(
        manager,
        user.id,
        user.role,
        metadata.requestId,
        'auth.login_succeeded',
        'admin_session',
        authenticated.session.id,
        { method: 'totp_enrollment' },
      );
      return {
        ok: true as const,
        sessionToken: authenticated.sessionToken,
        csrfToken: authenticated.csrfToken,
        principal: this.toPrincipal(user),
        recoveryCodes: rawRecoveryCodes,
      };
    });
    if (!result.ok) this.throwInvalidMfa(result.rateLimited);
    return result;
  }

  async rotateCsrf(sessionId: string): Promise<string> {
    const token = this.crypto.randomToken(24);
    await this.sessions.update(sessionId, { csrfHash: this.crypto.digest(token) });
    return token;
  }

  issueCsrfToken(): string {
    return this.crypto.randomToken(24);
  }

  async logout(sessionId: string, userId: string, role: string, requestId: string): Promise<void> {
    await this.sessions.update(sessionId, { revokedAt: new Date() });
    await this.audit.append({
      actorId: userId,
      actorRole: role,
      action: 'auth.logout',
      resourceType: 'admin_session',
      resourceId: sessionId,
      requestId,
    });
  }

  async principal(userId: string) {
    const user = await this.users.findOneByOrFail({ id: userId });
    return this.toPrincipal(user);
  }

  async listUsers(limit = 50) {
    const users = await this.users.find({
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
    return users.map((user) => this.toPrincipal(user));
  }

  async createUser(
    dto: CreateUserDto,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
  ) {
    if (dto.delivery === 'manual' && !dto.temporaryPassword) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Mật khẩu tạm là bắt buộc.');
    }
    const requestDigest = this.idempotency.digest({ dto });
    return this.dataSource.transaction(async (manager) => {
      const claim = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        actorId,
        'user.create',
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) return this.replayed(claim.response);
      const response =
        dto.delivery === 'invite'
          ? await this.createInviteRecord(
              manager,
              { ...dto, expiresInHours: 72 },
              actorId,
              actorRole,
              requestId,
            )
          : await this.createManualUser(manager, dto, actorId, actorRole, requestId);
      await this.idempotency.complete(
        manager,
        actorId,
        'user.create',
        idempotencyKey,
        response,
        201,
      );
      return response;
    });
  }

  async createInvite(
    dto: CreateInviteDto,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
  ) {
    const requestDigest = this.idempotency.digest({ dto });
    return this.dataSource.transaction(async (manager) => {
      const claim = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        actorId,
        'invite.create',
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) return this.replayed(claim.response);
      const response = await this.createInviteRecord(manager, dto, actorId, actorRole, requestId);
      await this.idempotency.complete(
        manager,
        actorId,
        'invite.create',
        idempotencyKey,
        response,
        202,
      );
      return response;
    });
  }

  async inspectInvite(dto: InspectInviteDto, metadata: RequestMetadata) {
    await this.rateLimits.enforceInviteInspect(metadata.ip, dto.token);
    const invite = await this.invites.findOneBy({ tokenHash: this.crypto.digest(dto.token) });
    if (!invite || !this.isInviteUsable(invite)) this.throwInvalidInvite();
    return {
      maskedEmail: this.maskEmail(invite.email),
      role: invite.role,
      expiresAt: invite.expiresAt.toISOString(),
      requiresMfaEnrollment: true,
    };
  }

  async acceptInvite(dto: AcceptInviteDto, metadata: RequestMetadata) {
    await this.rateLimits.enforceInviteAccept(metadata.ip, dto.token);
    if (dto.password !== dto.passwordConfirmation) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Mật khẩu xác nhận không khớp.');
    }
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    try {
      return await this.dataSource.transaction(async (manager) => {
        const invite = await manager.findOne(InviteEntity, {
          where: { tokenHash: this.crypto.digest(dto.token) },
          lock: { mode: 'pessimistic_write' },
        });
        if (!invite || !this.isInviteUsable(invite)) this.throwInvalidInvite();

        const normalizedEmail = invite.email.trim().toLowerCase();
        const normalizedUsername = invite.username.trim().toLowerCase();
        await this.lockIdentityKeys(manager, normalizedEmail, normalizedUsername);
        const identityUsers = await manager.find(UserEntity, {
          where: [{ emailNormalized: normalizedEmail }, { usernameNormalized: normalizedUsername }],
          lock: { mode: 'pessimistic_write' },
        });
        const emailUser = identityUsers.find((user) => user.emailNormalized === normalizedEmail);
        const usernameUser = identityUsers.find(
          (user) => user.usernameNormalized === normalizedUsername,
        );
        if (emailUser && usernameUser && emailUser.id !== usernameUser.id) {
          this.throwInviteIdentityConflict();
        }
        let user = emailUser ?? usernameUser;
        if (user) {
          const reusablePlaceholder =
            user.emailNormalized === normalizedEmail &&
            user.usernameNormalized === normalizedUsername &&
            ['inactive', 'invited'].includes(user.status) &&
            user.passwordHash === null &&
            user.disabledAt === null &&
            !user.mfaEnabled;
          if (!reusablePlaceholder) this.throwInviteIdentityConflict();
          user.email = normalizedEmail;
          user.username = normalizedUsername;
          user.displayName = invite.displayName.trim();
          user.role = invite.role;
          user.status = 'active';
          user.passwordHash = passwordHash;
          user.mustChangePassword = false;
          user.mfaEnabled = false;
          user.mfaSecretEncrypted = null;
          user.failedLoginCount = 0;
          user.lockedUntil = null;
          user = await manager.save(UserEntity, user);
        } else {
          user = await manager.save(UserEntity, {
            email: normalizedEmail,
            emailNormalized: normalizedEmail,
            username: normalizedUsername,
            usernameNormalized: normalizedUsername,
            displayName: invite.displayName.trim(),
            role: invite.role,
            status: 'active',
            passwordHash,
            mustChangePassword: false,
            mfaEnabled: false,
            mfaSecretEncrypted: null,
            failedLoginCount: 0,
            lockedUntil: null,
            disabledAt: null,
          });
        }

        const now = new Date();
        await manager.update(
          AdminSessionEntity,
          { userId: user.id, revokedAt: IsNull() },
          {
            revokedAt: now,
          },
        );
        await manager.delete(UserMfaRecoveryCodeEntity, { userId: user.id });
        await manager.delete(UserMfaMethodEntity, { userId: user.id });
        invite.usedAt = now;
        invite.acceptedUserId = user.id;
        await manager.save(InviteEntity, invite);
        await this.scrubInviteOutbox(manager, invite.id);
        const challenge = await this.createPreauthSession(manager, user.id, metadata);
        await this.insertAudit(
          manager,
          user.id,
          user.role,
          metadata.requestId,
          'user.created_from_invite',
          'user',
          user.id,
          { assignedRole: user.role, inviteId: invite.id },
        );
        await this.insertAudit(
          manager,
          user.id,
          user.role,
          metadata.requestId,
          'invite.accepted',
          'invite',
          invite.id,
          { assignedRole: user.role, userId: user.id },
        );
        return {
          token: challenge.token,
          csrfToken: challenge.csrfToken,
          data: {
            status: 'mfa_required' as const,
            mfaEnrollmentRequired: true,
            challengeExpiresAt: challenge.expiresAt.toISOString(),
          },
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) this.throwInviteIdentityConflict();
      throw error;
    }
  }

  async revokeInvite(
    inviteId: string,
    actorId: string,
    actorRole: string,
    requestId: string,
    idempotencyKey: string,
  ) {
    const requestDigest = this.idempotency.digest({ inviteId });
    return this.dataSource.transaction(async (manager) => {
      const claim = await this.idempotency.claim<Record<string, unknown>>(
        manager,
        actorId,
        'invite.revoke',
        idempotencyKey,
        requestDigest,
      );
      if (!claim.owner) return this.replayed(claim.response);
      const invite = await manager.findOne(InviteEntity, {
        where: { id: inviteId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!invite) {
        throw new AppException(404, 'INVITE_NOT_FOUND', 'Không tìm thấy lời mời.');
      }
      if (invite.usedAt) {
        throw new AppException(409, 'INVITE_NOT_REVOCABLE', 'Lời mời không thể thu hồi.');
      }
      const revokedAt = invite.revokedAt ?? new Date();
      if (!invite.revokedAt) {
        invite.revokedAt = revokedAt;
        await manager.save(InviteEntity, invite);
        await this.scrubInviteOutbox(manager, invite.id);
        await this.insertAudit(
          manager,
          actorId,
          actorRole,
          requestId,
          'invite.revoked',
          'invite',
          invite.id,
          {},
        );
      }
      const response = {
        id: invite.id,
        status: 'revoked' as const,
        revokedAt: revokedAt.toISOString(),
      };
      await this.idempotency.complete(
        manager,
        actorId,
        'invite.revoke',
        idempotencyKey,
        response,
        200,
      );
      return response;
    });
  }

  private async lockActivePreauth(
    manager: EntityManager,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    const rows = (await manager.query(
      `SELECT id,user_id,kind,expires_at,revoked_at,mfa_locked_until
       FROM admin_sessions WHERE id=$1 FOR UPDATE`,
      [sessionId],
    )) as Array<{
      id: string;
      user_id: string;
      kind: string;
      expires_at: Date;
      revoked_at: Date | null;
      mfa_locked_until: Date | null;
    }>;
    const session = rows[0];
    if (
      !session ||
      session.user_id !== userId ||
      session.kind !== 'preauth' ||
      session.revoked_at ||
      new Date(session.expires_at) <= new Date()
    ) {
      throw new AppException(401, 'AUTH_SESSION_EXPIRED', 'MFA challenge đã hết hạn.');
    }
    if (session.mfa_locked_until && new Date(session.mfa_locked_until) > new Date()) {
      throw new AppException(
        429,
        'AUTH_MFA_RATE_LIMITED',
        'Có quá nhiều lần xác thực không thành công.',
      );
    }
  }

  private async failedMfaAttempt(manager: EntityManager, sessionId: string) {
    await manager.query(
      `UPDATE admin_sessions
       SET mfa_failed_attempts=mfa_failed_attempts+1,
           mfa_locked_until=CASE
             WHEN mfa_failed_attempts+1 >= 5 THEN now()+interval '5 minutes'
             ELSE mfa_locked_until
           END
       WHERE id=$1
       RETURNING id`,
      [sessionId],
    );
    const rows = (await manager.query(
      `SELECT mfa_failed_attempts,mfa_locked_until FROM admin_sessions WHERE id=$1`,
      [sessionId],
    )) as Array<{ mfa_failed_attempts: number; mfa_locked_until: Date | null }>;
    return {
      ok: false as const,
      rateLimited: Boolean(rows[0]?.mfa_locked_until) || (rows[0]?.mfa_failed_attempts ?? 0) >= 5,
    };
  }

  private throwInvalidMfa(rateLimited: boolean): never {
    if (rateLimited) {
      throw new AppException(
        429,
        'AUTH_MFA_RATE_LIMITED',
        'Có quá nhiều lần xác thực không thành công.',
      );
    }
    throw new AppException(401, 'AUTH_MFA_INVALID', 'Mã xác thực không hợp lệ.');
  }

  private async verifyUserTotp(
    manager: EntityManager,
    user: UserEntity,
    code: string,
  ): Promise<boolean> {
    const method = await manager.findOne(UserMfaMethodEntity, {
      where: { userId: user.id, status: 'verified' },
      lock: { mode: 'pessimistic_write' },
    });
    if (!method) return false;
    const acceptedTimeStep = await this.verifyTotp(
      this.crypto.decrypt(method.secretEncrypted),
      code,
    );
    if (
      acceptedTimeStep === null ||
      (method.lastUsedTimeStep !== null && acceptedTimeStep <= Number(method.lastUsedTimeStep))
    ) {
      return false;
    }
    method.lastUsedTimeStep = String(acceptedTimeStep);
    await manager.save(UserMfaMethodEntity, method);
    return true;
  }

  private async verifyTotp(secret: string, code: string): Promise<number | null> {
    try {
      const verification = await verify({
        secret,
        token: code.replaceAll(' ', ''),
        epochTolerance: 30,
      });
      return verification.valid && 'timeStep' in verification ? verification.timeStep : null;
    } catch {
      return null;
    }
  }

  private async consumeRecoveryCode(
    manager: EntityManager,
    userId: string,
    rawCode: string,
  ): Promise<boolean> {
    const normalized = this.normalizeRecoveryCode(rawCode);
    if (!/^[A-F0-9]{20}$/.test(normalized)) return false;
    const rows = (await manager.query(
      `WITH consumed AS (
         UPDATE user_mfa_recovery_codes
         SET consumed_at=now()
         WHERE user_id=$1 AND code_digest=$2 AND consumed_at IS NULL
         RETURNING id
       )
       SELECT count(*)::integer AS count FROM consumed`,
      [userId, this.crypto.digest(normalized)],
    )) as Array<{ count: number }>;
    return rows[0]?.count === 1;
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
    return { session, sessionToken, csrfToken };
  }

  private async createPreauthSession(
    manager: EntityManager,
    userId: string,
    metadata: RequestMetadata,
  ) {
    const token = this.crypto.randomToken();
    const csrfToken = this.crypto.randomToken(24);
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const session = manager.create(AdminSessionEntity, {
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
    await manager.save(AdminSessionEntity, session);
    return { session, token, csrfToken, expiresAt };
  }

  private generateRecoveryCode(): string {
    return randomBytes(10)
      .toString('hex')
      .toUpperCase()
      .match(/.{1,4}/g)!
      .join('-');
  }

  private normalizeRecoveryCode(code: string): string {
    return code.replace(/[\s-]/g, '').toUpperCase();
  }

  private async createManualUser(
    manager: EntityManager,
    dto: CreateUserDto,
    actorId: string,
    actorRole: string,
    requestId: string,
  ) {
    const user = await manager.save(UserEntity, {
      email: dto.email.trim(),
      emailNormalized: dto.email.trim().toLowerCase(),
      username: dto.username.trim(),
      usernameNormalized: dto.username.trim().toLowerCase(),
      displayName: dto.displayName.trim(),
      role: dto.role,
      status: 'active',
      passwordHash: await argon2.hash(dto.temporaryPassword!, { type: argon2.argon2id }),
      mustChangePassword: true,
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      failedLoginCount: 0,
      lockedUntil: null,
      disabledAt: null,
    });
    await this.insertAudit(
      manager,
      actorId,
      actorRole,
      requestId,
      'user.created_manual',
      'user',
      user.id,
      {
        assignedRole: dto.role,
      },
    );
    return this.toPrincipal(user);
  }

  private async createInviteRecord(
    manager: EntityManager,
    dto: CreateInviteDto,
    actorId: string,
    actorRole: string,
    requestId: string,
  ) {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const normalizedUsername = dto.username.trim().toLowerCase();
    await this.lockIdentityKeys(manager, normalizedEmail, normalizedUsername);
    const userConflict = await manager.findOne(UserEntity, {
      where: [{ emailNormalized: normalizedEmail }, { usernameNormalized: normalizedUsername }],
    });
    if (userConflict) {
      throw new AppException(
        409,
        'INVITE_IDENTITY_CONFLICT',
        'Email hoặc tên đăng nhập đã thuộc một tài khoản nội bộ.',
      );
    }
    const probes = await manager.find(InviteEntity, {
      where: [
        { email: normalizedEmail, usedAt: IsNull(), revokedAt: IsNull() },
        { username: normalizedUsername, usedAt: IsNull(), revokedAt: IsNull() },
      ],
      order: { createdAt: 'DESC' },
    });
    const now = new Date();
    const activeProbes = probes.filter((probe) => probe.expiresAt > now);
    const matchingProbe = activeProbes.find(
      (probe) => probe.email === normalizedEmail && probe.username === normalizedUsername,
    );
    if (matchingProbe) {
      if (matchingProbe.displayName !== dto.displayName.trim() || matchingProbe.role !== dto.role) {
        throw new AppException(
          409,
          'INVITE_ACTIVE_CONFLICT',
          'Email đã có lời mời đang hoạt động với thông tin khác.',
        );
      }
      return this.inviteResponse(matchingProbe);
    }
    if (activeProbes.length > 0) {
      throw new AppException(
        409,
        'INVITE_ACTIVE_CONFLICT',
        'Email hoặc tên đăng nhập đã có lời mời đang hoạt động.',
      );
    }
    for (const expired of probes) {
      await manager.update(InviteEntity, expired.id, { revokedAt: now });
      await this.scrubInviteOutbox(manager, expired.id);
    }
    const token = this.crypto.randomToken();
    const expiresAt = new Date(Date.now() + dto.expiresInHours * 60 * 60_000);
    const invite = await manager.save(InviteEntity, {
      email: normalizedEmail,
      username: normalizedUsername,
      displayName: dto.displayName.trim(),
      role: dto.role,
      tokenHash: this.crypto.digest(token),
      createdBy: actorId,
      expiresAt,
      usedAt: null,
      revokedAt: null,
      acceptedUserId: null,
    });
    await manager.insert(MailOutboxEntity, {
      templateKey: 'identity.invite',
      recipientEmail: invite.email,
      inviteId: invite.id,
      payloadEncrypted: this.crypto.encrypt(JSON.stringify({ inviteId: invite.id, token })),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      correlationId: requestId,
    });
    await this.insertAudit(
      manager,
      actorId,
      actorRole,
      requestId,
      'invite.created',
      'invite',
      invite.id,
      {
        assignedRole: dto.role,
      },
    );
    return this.inviteResponse(invite);
  }

  private async lockIdentityKeys(
    manager: EntityManager,
    normalizedEmail: string,
    normalizedUsername: string,
  ): Promise<void> {
    const keys = [
      `identity:email:${normalizedEmail}`,
      `identity:username:${normalizedUsername}`,
    ].sort();
    for (const key of keys) {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    }
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

  private isInviteUsable(invite: InviteEntity): boolean {
    return !invite.usedAt && !invite.revokedAt && invite.expiresAt > new Date();
  }

  private throwInvalidInvite(): never {
    throw new AppException(
      400,
      'INVITE_INVALID_OR_EXPIRED',
      'Lời mời không hợp lệ hoặc đã hết hạn.',
    );
  }

  private throwInviteIdentityConflict(): never {
    throw new AppException(
      409,
      'INVITE_ACCEPTANCE_CONFLICT',
      'Không thể hoàn tất lời mời với thông tin hiện tại.',
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    return (error.driverError as { code?: string } | undefined)?.code === '23505';
  }

  private maskEmail(email: string): string {
    const [local = '', domain = ''] = email.split('@');
    const visible = local.slice(0, 1);
    return `${visible}${'*'.repeat(Math.max(3, local.length - 1))}@${domain}`;
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
    await manager.query(
      `INSERT INTO audit_logs(actor_id,actor_role,action,resource_type,resource_id,request_id,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [actorId, actorRole, action, resourceType, resourceId, requestId, JSON.stringify(metadata)],
    );
  }

  private replayed<T>(response: T | null): T {
    if (response) return response;
    throw new AppException(409, 'IDEMPOTENCY_IN_PROGRESS', 'Lệnh đang được xử lý.');
  }

  private async recordFailedLogin(user: UserEntity): Promise<void> {
    const count = user.failedLoginCount + 1;
    const lockMinutes = count >= 5 ? Math.min(30, 2 ** (count - 5)) : 0;
    await this.users.update(user.id, {
      failedLoginCount: count,
      lockedUntil: lockMinutes ? new Date(Date.now() + lockMinutes * 60_000) : null,
    });
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

  private inviteResponse(invite: InviteEntity) {
    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      status: 'pending',
      expiresAt: invite.expiresAt.toISOString(),
    };
  }
}
