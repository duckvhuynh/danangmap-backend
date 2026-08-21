import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/http/request-context';
import { Principal } from './auth.decorators';
import { LoginDto, VerifyMfaDto } from './auth.dto';
import {
  CSRF_COOKIE,
  CsrfGuard,
  PREAUTH_COOKIE,
  PreAuthGuard,
  SESSION_COOKIE,
  SessionGuard,
} from './auth.guards';
import { AuthService } from './auth.service';

@ApiTags('authentication')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly secure: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService,
  ) {
    this.secure = config.getOrThrow<boolean>('app.cookieSecure');
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ operationId: 'login' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(dto, this.metadata(request));
    response.cookie(PREAUTH_COOKIE, result.token, this.cookieOptions(5 * 60_000));
    return result.data;
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @UseGuards(PreAuthGuard)
  @ApiOperation({ operationId: 'verifyMfa' })
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.auth.verifyMfa(
      principal.id,
      principal.sessionId,
      dto.code,
      this.metadata(request),
    );
    response.clearCookie(PREAUTH_COOKIE, this.cookieOptions(0));
    response.cookie(SESSION_COOKIE, result.sessionToken, this.cookieOptions(8 * 60 * 60_000));
    response.cookie(CSRF_COOKIE, result.csrfToken, {
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      httpOnly: false,
      maxAge: 8 * 60 * 60_000,
    });
    return result.principal;
  }

  @Get('csrf')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('adminSession')
  @ApiOperation({ operationId: 'rotateCsrf' })
  async csrf(
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = await this.auth.rotateCsrf(principal.sessionId);
    response.cookie(CSRF_COOKIE, token, {
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      httpOnly: false,
      maxAge: 8 * 60 * 60_000,
    });
    return { csrfToken: token };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('adminSession')
  @ApiOperation({ operationId: 'getCurrentUser' })
  me(@Principal() principal: NonNullable<RequestWithContext['principal']>) {
    return this.auth.principal(principal.id);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiCookieAuth('adminSession')
  @ApiOperation({ operationId: 'logout' })
  async logout(
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(principal.sessionId, principal.id, principal.role, request.requestId);
    response.clearCookie(SESSION_COOKIE, this.cookieOptions(0));
    response.clearCookie(CSRF_COOKIE, { path: '/' });
    return { status: 'logged_out', recoveryAction: 'delete' };
  }

  private cookieOptions(maxAge: number) {
    return {
      secure: this.secure,
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      maxAge,
    };
  }

  private metadata(request: RequestWithContext) {
    return {
      requestId: request.requestId,
      ip: request.ip,
      userAgent: request.header('user-agent'),
    };
  }
}
