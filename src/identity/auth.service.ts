import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import argon2 from 'argon2';
import { verify } from 'otplib';
import { IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { AppException } from '../common/http/app.exception';
import type { CreateInviteDto, CreateUserDto, LoginDto } from './auth.dto';
import {
  AdminSessionEntity,
  InviteEntity,
  MailOutboxEntity,
  UserEntity,
} from './identity.entities';

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
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await this.sessions.insert({
      userId: user.id,
      tokenHash: this.crypto.digest(token),
      csrfHash: null,
      kind: 'preauth',
      expiresAt,
      revokedAt: null,
      ipHash: metadata.ip ? this.crypto.digest(metadata.ip) : null,
      userAgent: metadata.userAgent?.slice(0, 512) ?? null,
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
    code: string,
    metadata: RequestMetadata,
  ) {
    const user = await this.users.findOneBy({ id: userId });
    if (!user?.mfaEnabled || !user.mfaSecretEncrypted) {
      throw new AppException(401, 'AUTH_MFA_REQUIRED', 'Tài khoản cần đăng ký MFA.');
    }
    const secret = this.crypto.decrypt(user.mfaSecretEncrypted);
    const verification = await verify({
      secret,
      token: code.replaceAll(' ', ''),
      epochTolerance: 30,
    });
    if (!verification.valid) {
      throw new AppException(401, 'AUTH_MFA_INVALID', 'Mã xác thực không hợp lệ.');
    }
    const sessionToken = this.crypto.randomToken();
    const csrfToken = this.crypto.randomToken(24);
    const session = this.sessions.create({
      userId,
      tokenHash: this.crypto.digest(sessionToken),
      csrfHash: this.crypto.digest(csrfToken),
      kind: 'authenticated',
      expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
      revokedAt: null,
      ipHash: metadata.ip ? this.crypto.digest(metadata.ip) : null,
      userAgent: metadata.userAgent?.slice(0, 512) ?? null,
    });
    await this.sessions.manager.transaction(async (manager) => {
      await manager.update(AdminSessionEntity, preauthSessionId, { revokedAt: new Date() });
      await manager.save(AdminSessionEntity, session);
    });
    await this.audit.append({
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login_succeeded',
      resourceType: 'admin_session',
      resourceId: session.id,
      requestId: metadata.requestId,
    });
    return { sessionToken, csrfToken, principal: this.toPrincipal(user) };
  }

  async rotateCsrf(sessionId: string): Promise<string> {
    const token = this.crypto.randomToken(24);
    await this.sessions.update(sessionId, { csrfHash: this.crypto.digest(token) });
    return token;
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

  async createUser(dto: CreateUserDto, actorId: string, actorRole: string, requestId: string) {
    if (dto.delivery === 'manual' && !dto.temporaryPassword) {
      throw new AppException(422, 'VALIDATION_FAILED', 'Mật khẩu tạm là bắt buộc.');
    }
    if (dto.delivery === 'invite') {
      return this.createInvite({ ...dto, expiresInHours: 72 }, actorId, actorRole, requestId);
    }
    const user = await this.users.save({
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
    await this.audit.append({
      actorId,
      actorRole,
      action: 'user.created_manual',
      resourceType: 'user',
      resourceId: user.id,
      requestId,
      metadata: { assignedRole: dto.role },
    });
    return this.toPrincipal(user);
  }

  async createInvite(dto: CreateInviteDto, actorId: string, actorRole: string, requestId: string) {
    const idempotencyProbe = await this.invites.findOne({
      where: { email: dto.email.trim().toLowerCase(), usedAt: IsNull(), revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    if (idempotencyProbe?.expiresAt && idempotencyProbe.expiresAt > new Date()) {
      return this.inviteResponse(idempotencyProbe);
    }
    const token = this.crypto.randomToken();
    const expiresAt = new Date(Date.now() + dto.expiresInHours * 60 * 60_000);
    const invite = await this.invites.save({
      email: dto.email.trim().toLowerCase(),
      username: dto.username.trim().toLowerCase(),
      displayName: dto.displayName.trim(),
      role: dto.role,
      tokenHash: this.crypto.digest(token),
      createdBy: actorId,
      expiresAt,
      usedAt: null,
      revokedAt: null,
    });
    await this.mailOutbox.insert({
      templateKey: 'identity.invite',
      recipientEmail: invite.email,
      payloadEncrypted: this.crypto.encrypt(JSON.stringify({ inviteId: invite.id, token })),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      correlationId: requestId,
    });
    await this.audit.append({
      actorId,
      actorRole,
      action: 'invite.created',
      resourceType: 'invite',
      resourceId: invite.id,
      requestId,
      metadata: { assignedRole: dto.role },
    });
    return this.inviteResponse(invite);
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
