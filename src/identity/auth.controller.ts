import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/http/request-context';
import {
  apiJsonResponse,
  authPrincipalSchema,
  csrfResultSchema,
  inviteInspectionSchema,
  loginResultSchema,
  logoutResultSchema,
  mfaEnrollmentConfirmationSchema,
  mfaEnrollmentSchema,
} from '../common/openapi/response-schemas';
import { Principal } from './auth.decorators';
import {
  AcceptInviteDto,
  ConfirmMfaEnrollmentDto,
  InspectInviteDto,
  LoginDto,
  VerifyMfaDto,
} from './auth.dto';
import {
  CSRF_COOKIE,
  CsrfGuard,
  OptionalAuthGuard,
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
  @UseGuards(CsrfGuard)
  @ApiSecurity('csrf')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'login' })
  @apiJsonResponse(200, loginResultSchema)
  async login(
    @Body() dto: LoginDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(dto, this.metadata(request));
    response.cookie(PREAUTH_COOKIE, result.token, this.cookieOptions(5 * 60_000));
    this.setCsrfCookie(response, result.csrfToken, 5 * 60_000);
    return result.data;
  }

  @Post('invites\\:inspect')
  @HttpCode(200)
  @ApiOperation({ operationId: 'inspectInvite' })
  @apiJsonResponse(200, inviteInspectionSchema)
  inspectInvite(@Body() dto: InspectInviteDto, @Req() request: RequestWithContext) {
    return this.auth.inspectInvite(dto, this.metadata(request));
  }

  @Post('invites\\:accept')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiSecurity('csrf')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'acceptInvite' })
  @apiJsonResponse(200, loginResultSchema)
  async acceptInvite(
    @Body() dto: AcceptInviteDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.acceptInvite(dto, this.metadata(request));
    response.cookie(PREAUTH_COOKIE, result.token, this.cookieOptions(5 * 60_000));
    this.setCsrfCookie(response, result.csrfToken, 5 * 60_000);
    return result.data;
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @UseGuards(PreAuthGuard, CsrfGuard)
  @ApiSecurity({ preauthSession: [], csrf: [] })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'verifyMfa' })
  @apiJsonResponse(200, authPrincipalSchema)
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.auth.verifyMfa(
      principal.id,
      principal.sessionId,
      dto.method,
      dto.code,
      this.metadata(request),
    );
    response.clearCookie(PREAUTH_COOKIE, this.cookieOptions(0));
    response.cookie(SESSION_COOKIE, result.sessionToken, this.cookieOptions(8 * 60 * 60_000));
    this.setCsrfCookie(response, result.csrfToken, 8 * 60 * 60_000);
    return result.principal;
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  @UseGuards(PreAuthGuard, CsrfGuard)
  @ApiSecurity({ preauthSession: [], csrf: [] })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'startMfaEnrollment' })
  @apiJsonResponse(200, mfaEnrollmentSchema)
  enrollMfa(
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.auth.startMfaEnrollment(principal.id, principal.sessionId, this.metadata(request));
  }

  @Post('mfa/enroll/confirm')
  @HttpCode(200)
  @UseGuards(PreAuthGuard, CsrfGuard)
  @ApiSecurity({ preauthSession: [], csrf: [] })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'confirmMfaEnrollment' })
  @apiJsonResponse(200, mfaEnrollmentConfirmationSchema)
  async confirmMfaEnrollment(
    @Body() dto: ConfirmMfaEnrollmentDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.auth.confirmMfaEnrollment(
      principal.id,
      principal.sessionId,
      dto.code,
      this.metadata(request),
    );
    response.clearCookie(PREAUTH_COOKIE, this.cookieOptions(0));
    response.cookie(SESSION_COOKIE, result.sessionToken, this.cookieOptions(8 * 60 * 60_000));
    this.setCsrfCookie(response, result.csrfToken, 8 * 60 * 60_000);
    return { principal: result.principal, recoveryCodes: result.recoveryCodes };
  }

  @Get('csrf')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ operationId: 'rotateCsrf' })
  @apiJsonResponse(200, csrfResultSchema)
  async csrf(
    @Principal() principal: RequestWithContext['principal'],
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = principal
      ? await this.auth.rotateCsrf(principal.sessionId)
      : this.auth.issueCsrfToken();
    this.setCsrfCookie(
      response,
      token,
      principal && principal.role !== 'preauth' ? 8 * 60 * 60_000 : 5 * 60_000,
    );
    return { csrfToken: token };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('adminSession')
  @ApiOperation({ operationId: 'getCurrentUser' })
  @apiJsonResponse(200, authPrincipalSchema)
  me(@Principal() principal: NonNullable<RequestWithContext['principal']>) {
    return this.auth.principal(principal.id);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiCookieAuth('adminSession')
  @ApiOperation({ operationId: 'logout' })
  @apiJsonResponse(200, logoutResultSchema)
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

  private setCsrfCookie(response: Response, token: string, maxAge: number): void {
    response.cookie(CSRF_COOKIE, token, {
      secure: this.secure,
      sameSite: 'lax',
      path: '/',
      httpOnly: false,
      maxAge,
    });
  }

  private metadata(request: RequestWithContext) {
    return {
      requestId: request.requestId,
      ip: request.ip,
      userAgent: request.header('user-agent'),
    };
  }
}
