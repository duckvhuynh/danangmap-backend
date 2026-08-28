import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/http/request-context';
import {
  apiJsonResponse,
  apiProblemResponse,
  authPrincipalSchema,
  bootstrapStatusSchema,
  csrfResultSchema,
  envelopeSchema,
  inviteInspectionSchema,
  loginResultSchema,
  logoutResultSchema,
  mfaEnrollmentConfirmationSchema,
  mfaEnrollmentSchema,
  recoveryCodesRegenerationSchema,
  passwordChangeResultSchema,
  passwordResetConfirmationSchema,
  passwordResetRequestResultSchema,
  sessionRevocationResultSchema,
} from '../common/openapi/response-schemas';
import { requireIdempotencyKey } from '../layers/etag';
import { Principal } from './auth.decorators';
import {
  AcceptInviteDto,
  BootstrapSystemAdminDto,
  ChangePasswordDto,
  ConfirmMfaEnrollmentDto,
  InspectInviteDto,
  LoginDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RegenerateRecoveryCodesDto,
  VerifyMfaDto,
} from './auth.dto';
import {
  CSRF_COOKIE,
  CsrfGuard,
  OptionalAuthGuard,
  preauthCookieName,
  PreAuthGuard,
  sessionCookieName,
  SessionGuard,
} from './auth.guards';
import { AuthService } from './auth.service';
import { PasswordSecurityService } from './password-security.service';
import { FirstAdminBootstrapService } from './first-admin-bootstrap.service';

interface AuthTransitionCookies {
  sessionKind: 'preauth' | 'authenticated';
  token: string;
  csrfToken: string;
}

@ApiTags('authentication')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly secure: boolean;
  private readonly sessionCookie: string;
  private readonly preauthCookie: string;

  constructor(
    private readonly auth: AuthService,
    private readonly passwordSecurity: PasswordSecurityService,
    private readonly firstAdminBootstrap: FirstAdminBootstrapService,
    config: ConfigService,
  ) {
    this.secure = config.getOrThrow<boolean>('app.cookieSecure');
    this.sessionCookie = sessionCookieName(this.secure);
    this.preauthCookie = preauthCookieName(this.secure);
  }

  @Get('bootstrap/status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'getBootstrapStatus',
    description:
      'Returns only whether a configured first-System-Admin bootstrap may run against the empty users table.',
  })
  @apiJsonResponse(200, bootstrapStatusSchema)
  bootstrapStatus() {
    return this.firstAdminBootstrap.status();
  }

  @Post('bootstrap/system-admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ initialAdminBootstrapToken: [], csrf: [] })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiHeader({
    name: 'X-Initial-Admin-Bootstrap-Token',
    required: true,
    schema: { type: 'string', minLength: 43, maxLength: 512, writeOnly: true },
  })
  @ApiOperation({
    operationId: 'bootstrapSystemAdmin',
    description:
      'Creates the only first System Admin. Returns an authenticated session when MFA is disabled, otherwise an MFA-enrollment pre-auth challenge. The bootstrap token is never returned or persisted.',
  })
  @apiJsonResponse(201, loginResultSchema)
  @apiProblemResponse(401, ['BOOTSTRAP_TOKEN_INVALID'])
  @apiProblemResponse(403, ['CSRF_INVALID'])
  @apiProblemResponse(409, ['BOOTSTRAP_ALREADY_COMPLETED'])
  @apiProblemResponse(422, ['VALIDATION_FAILED', 'BOOTSTRAP_PASSWORD_WEAK'])
  @apiProblemResponse(429, ['RATE_LIMITED'])
  @apiProblemResponse(503, ['BOOTSTRAP_UNAVAILABLE', 'AUTH_RATE_LIMIT_UNAVAILABLE'])
  async bootstrapSystemAdmin(
    @Headers('x-initial-admin-bootstrap-token') bootstrapToken: string | undefined,
    @Body() dto: BootstrapSystemAdminDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.firstAdminBootstrap.createSystemAdmin(
      dto,
      bootstrapToken,
      this.metadata(request),
    );
    this.setAuthTransitionCookies(response, result);
    return result.data;
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
    this.setAuthTransitionCookies(response, result);
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
    this.setAuthTransitionCookies(response, result);
    return result.data;
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @UseGuards(PreAuthGuard, CsrfGuard)
  @ApiSecurity({ preauthSession: [], csrf: [] })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'verifyMfa' })
  @apiJsonResponse(200, authPrincipalSchema)
  @apiProblemResponse(409, ['MFA_DISABLED'])
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
    response.clearCookie(this.preauthCookie, this.cookieOptions(0));
    response.cookie(this.sessionCookie, result.sessionToken, this.cookieOptions(8 * 60 * 60_000));
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
  @apiProblemResponse(409, ['MFA_DISABLED'])
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
  @apiProblemResponse(409, ['MFA_DISABLED'])
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
    response.clearCookie(this.preauthCookie, this.cookieOptions(0));
    response.cookie(this.sessionCookie, result.sessionToken, this.cookieOptions(8 * 60 * 60_000));
    this.setCsrfCookie(response, result.csrfToken, 8 * 60 * 60_000);
    return { principal: result.principal, recoveryCodes: result.recoveryCodes };
  }

  @Post('mfa/recovery-codes\\:regenerate')
  @HttpCode(200)
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({
    operationId: 'regenerateRecoveryCodes',
    description:
      'Replaces every recovery code after password and MFA re-authentication. Codes are returned only to the authenticated owner and never stored in an idempotency receipt.',
  })
  @apiJsonResponse(200, recoveryCodesRegenerationSchema)
  @apiProblemResponse(409, ['MFA_DISABLED'])
  regenerateRecoveryCodes(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: RegenerateRecoveryCodesDto,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.auth.regenerateRecoveryCodes(
      principal.id,
      principal.role,
      dto,
      this.metadata(request),
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Get('csrf')
  @UseGuards(OptionalAuthGuard)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    operationId: 'getCsrfToken',
    description:
      'Issues or reuses a public CSRF token. Pre-authenticated and authenticated sessions receive their current session-bound token without rotation.',
  })
  @ApiResponse({
    status: 200,
    headers: {
      'Cache-Control': {
        description: 'CSRF responses are private and must never be stored.',
        schema: { type: 'string', enum: ['private, no-store'] },
      },
    },
    schema: envelopeSchema(csrfResultSchema),
  })
  @ApiResponse({
    status: 403,
    content: {
      'application/problem+json': {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'type',
            'title',
            'status',
            'code',
            'message',
            'details',
            'requestId',
            'timestamp',
          ],
          properties: {
            type: { type: 'string', format: 'uri' },
            title: { type: 'string' },
            status: { type: 'integer', enum: [403] },
            code: { type: 'string', enum: ['CSRF_INVALID'] },
            message: { type: 'string' },
            details: { type: 'object', additionalProperties: true },
            requestId: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  })
  async csrf(
    @Principal() principal: RequestWithContext['principal'],
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const presentedToken = request.cookies?.[CSRF_COOKIE] as unknown;
    const token = principal
      ? await this.auth.getSessionCsrf(principal.sessionId, presentedToken)
      : this.auth.getPublicCsrf(presentedToken);
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

  @Post('password/change')
  @HttpCode(200)
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({
    operationId: 'changePassword',
    description:
      'Concurrent retries share one effect. Only the owning response rotates cookies; a retry after the old session is revoked returns 401.',
  })
  @apiJsonResponse(200, passwordChangeResultSchema)
  async changePassword(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: ChangePasswordDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.passwordSecurity.changePassword(
      principal.id,
      principal.sessionId,
      principal.role,
      dto,
      this.metadata(request),
      key,
    );
    if (result.owner && result.sessionToken && result.csrfToken) {
      response.clearCookie(this.preauthCookie, this.cookieOptions(0));
      response.cookie(this.sessionCookie, result.sessionToken, this.cookieOptions(8 * 60 * 60_000));
      this.setCsrfCookie(response, result.csrfToken, 8 * 60 * 60_000);
    }
    return result.data;
  }

  @Post('password/reset\\:request')
  @HttpCode(202)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOperation({ operationId: 'requestPasswordReset' })
  @apiJsonResponse(202, passwordResetRequestResultSchema)
  requestPasswordReset(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: PasswordResetRequestDto,
    @Req() request: RequestWithContext,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.passwordSecurity.requestPasswordReset(dto, this.metadata(request), key);
  }

  @Post('password/reset\\:confirm')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiSecurity('csrf')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'confirmPasswordReset' })
  @apiJsonResponse(200, passwordResetConfirmationSchema)
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.passwordSecurity.confirmPasswordReset(dto, this.metadata(request));
    this.clearAuthCookies(response);
    this.setCsrfCookie(response, this.auth.issueCsrfToken(), 5 * 60_000);
    return result;
  }

  @Post('sessions\\:revoke-all')
  @HttpCode(200)
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({
    operationId: 'revokeAllSessions',
    description:
      'Revokes every session including the caller. Concurrent retries share one effect; a later retry with the revoked cookie returns 401.',
  })
  @apiJsonResponse(200, sessionRevocationResultSchema)
  async revokeAllSessions(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.passwordSecurity.revokeAllSessions(
      principal.id,
      principal.sessionId,
      principal.role,
      request.requestId,
      key,
    );
    this.clearAuthCookies(response);
    return result;
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard, CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'logout' })
  @apiJsonResponse(200, logoutResultSchema)
  async logout(
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(principal.sessionId, principal.id, principal.role, request.requestId);
    this.clearAuthCookies(response);
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

  private setAuthTransitionCookies(response: Response, result: AuthTransitionCookies): void {
    const maxAge = result.sessionKind === 'authenticated' ? 8 * 60 * 60_000 : 5 * 60_000;
    if (result.sessionKind === 'authenticated') {
      response.clearCookie(this.preauthCookie, this.cookieOptions(0));
      response.cookie(this.sessionCookie, result.token, this.cookieOptions(maxAge));
    } else {
      response.clearCookie(this.sessionCookie, this.cookieOptions(0));
      response.cookie(this.preauthCookie, result.token, this.cookieOptions(maxAge));
    }
    this.setCsrfCookie(response, result.csrfToken, maxAge);
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

  private clearAuthCookies(response: Response): void {
    response.clearCookie(this.sessionCookie, this.cookieOptions(0));
    response.clearCookie(this.preauthCookie, this.cookieOptions(0));
    response.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  private metadata(request: RequestWithContext) {
    return {
      requestId: request.requestId,
      ip: request.ip,
      userAgent: request.header('user-agent'),
    };
  }
}
