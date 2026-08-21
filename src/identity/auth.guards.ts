import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { timingSafeEqual } from 'node:crypto';
import { Repository } from 'typeorm';
import { AppException } from '../common/http/app.exception';
import type { RequestWithContext } from '../common/http/request-context';
import { frontendOrigins } from '../config/environment';
import type { UserRole } from '../domain/enums';
import { CryptoService } from '../common/crypto/crypto.service';
import { AdminSessionEntity, UserEntity } from './identity.entities';
import { ROLES_KEY } from './auth.decorators';

export const SESSION_COOKIE = '__Host-danangmap_session';
export const PREAUTH_COOKIE = '__Host-danangmap_preauth';
export const CSRF_COOKIE = 'danangmap_csrf';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @InjectRepository(AdminSessionEntity)
    private readonly sessions: Repository<AdminSessionEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const rawToken = request.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!rawToken) throw new UnauthorizedException('Phiên đăng nhập đã hết hạn.');
    const session = await this.sessions.findOneBy({
      tokenHash: this.crypto.digest(rawToken),
      kind: 'authenticated',
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Phiên đăng nhập đã hết hạn.');
    }
    const user = await this.users.findOneBy({ id: session.userId });
    if (!user || user.status !== 'active' || user.disabledAt) {
      throw new UnauthorizedException('Phiên đăng nhập đã hết hạn.');
    }
    request.principal = {
      id: user.id,
      role: user.role,
      sessionId: session.id,
      displayName: user.displayName,
    };
    return true;
  }
}

@Injectable()
export class PreAuthGuard implements CanActivate {
  constructor(
    @InjectRepository(AdminSessionEntity)
    private readonly sessions: Repository<AdminSessionEntity>,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const rawToken = request.cookies?.[PREAUTH_COOKIE] as string | undefined;
    if (!rawToken) throw new UnauthorizedException('MFA challenge đã hết hạn.');
    const session = await this.sessions.findOneBy({
      tokenHash: this.crypto.digest(rawToken),
      kind: 'preauth',
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('MFA challenge đã hết hạn.');
    }
    request.principal = {
      id: session.userId,
      role: 'preauth',
      sessionId: session.id,
      displayName: '',
    };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const principal = context.switchToHttp().getRequest<RequestWithContext>().principal;
    if (!principal || !roles.includes(principal.role as UserRole)) {
      throw new AppException(403, 'ROLE_FORBIDDEN', 'Bạn không có quyền thực hiện thao tác này.');
    }
    return true;
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly origins: string[];

  constructor(
    @InjectRepository(AdminSessionEntity)
    private readonly sessions: Repository<AdminSessionEntity>,
    config: ConfigService,
    private readonly crypto: CryptoService,
  ) {
    this.origins = frontendOrigins(config.getOrThrow<string>('app.frontendOrigins'));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const principal = request.principal;
    if (!principal) throw new UnauthorizedException('Phiên đăng nhập đã hết hạn.');
    const originHeader = request.header('origin');
    const refererHeader = request.header('referer');
    const candidateOrigin = originHeader
      ? new URL(originHeader).origin
      : refererHeader
        ? new URL(refererHeader).origin
        : null;
    if (!candidateOrigin || !this.origins.includes(candidateOrigin)) {
      throw new AppException(403, 'CSRF_INVALID', 'Nguồn yêu cầu không hợp lệ.');
    }
    const csrfHeader = request.header('x-csrf-token');
    const csrfCookie = request.cookies?.[CSRF_COOKIE] as string | undefined;
    if (!csrfHeader || !csrfCookie || !this.equal(csrfHeader, csrfCookie)) {
      throw new AppException(403, 'CSRF_INVALID', 'CSRF token không hợp lệ.');
    }
    const session = await this.sessions.findOneBy({ id: principal.sessionId });
    if (!session?.csrfHash || !this.equal(session.csrfHash, this.crypto.digest(csrfHeader))) {
      throw new AppException(403, 'CSRF_INVALID', 'CSRF token không hợp lệ.');
    }
    return true;
  }

  private equal(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
