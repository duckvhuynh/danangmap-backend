import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/http/request-context';
import { requireIdempotencyKey } from '../layers/etag';
import {
  apiJsonResponse,
  apiProblemResponse,
  adminInviteResendResultSchema,
  adminInviteSchema,
  adminMfaResetResultSchema,
  adminPasswordResetRequestResultSchema,
  adminSessionRevocationResultSchema,
  adminUserDetailSchema,
  adminUserListItemSchema,
  apiVersionedJsonResponse,
  inviteRevocationSchema,
  inviteResultSchema,
  userCreationResultSchema,
  userListMetaSchema,
} from '../common/openapi/response-schemas';
import { Principal, Roles } from './auth.decorators';
import {
  AdminReasonDto,
  CreateInviteDto,
  CreateUserDto,
  ListInvitesQueryDto,
  ListUsersQueryDto,
  ResendInviteDto,
  UpdateUserDto,
} from './auth.dto';
import { CsrfGuard, RolesGuard, SessionGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { AdminIdentityService } from './admin-identity.service';
import { requireIdentityVersion } from './identity-etag';

@ApiTags('admin-users')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
export class UsersController {
  constructor(
    private readonly auth: AuthService,
    private readonly adminIdentity: AdminIdentityService,
  ) {}

  @Get('users')
  @Roles('system_admin')
  @ApiCookieAuth('adminSession')
  @ApiOperation({ operationId: 'listUsers' })
  @ApiQuery({ name: 'q', required: false, type: String, minLength: 2, maxLength: 100 })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: ['system_admin', 'editor', 'reviewer', 'publisher'],
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'inactive', 'disabled', 'invited'],
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200 })
  @apiJsonResponse(200, { type: 'array', items: adminUserListItemSchema }, userListMetaSchema)
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.adminIdentity.listUsers(query);
  }

  @Get('users/:userId')
  @Roles('system_admin')
  @ApiCookieAuth('adminSession')
  @ApiOperation({ operationId: 'getAdminUser' })
  @apiVersionedJsonResponse(200, adminUserDetailSchema)
  async getUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.adminIdentity.getUser(userId);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Patch('users/:userId')
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'updateAdminUser' })
  @apiVersionedJsonResponse(200, adminUserDetailSchema)
  async updateUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateUserDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.adminIdentity.updateUser(
      userId,
      dto,
      requireIdentityVersion(ifMatch, 'user', userId),
      principal.id,
      principal.role,
      request.requestId,
      requireIdempotencyKey(idempotencyKey),
      request.ip,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('users')
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'createUser' })
  @apiJsonResponse(201, userCreationResultSchema)
  async createUser(
    @Body() dto: CreateUserDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.auth.createUser(dto, principal.id, principal.role, request.requestId, key);
  }

  @Post('invites')
  @HttpCode(202)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'createInvite' })
  @apiJsonResponse(202, inviteResultSchema)
  async createInvite(
    @Body() dto: CreateInviteDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.auth.createInvite(dto, principal.id, principal.role, request.requestId, key);
  }

  @Post('invites/:inviteId\\:revoke')
  @HttpCode(200)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'revokeInvite' })
  @apiJsonResponse(200, inviteRevocationSchema)
  revokeInvite(
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.auth.revokeInvite(inviteId, principal.id, principal.role, request.requestId, key);
  }

  @Get('invites')
  @Roles('system_admin')
  @ApiCookieAuth('adminSession')
  @ApiOperation({ operationId: 'listAdminInvites' })
  @ApiQuery({ name: 'q', required: false, type: String, minLength: 2, maxLength: 100 })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'expired', 'revoked', 'accepted'],
  })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: ['system_admin', 'editor', 'reviewer', 'publisher'],
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200 })
  @apiJsonResponse(200, { type: 'array', items: adminInviteSchema }, userListMetaSchema)
  listInvites(@Query() query: ListInvitesQueryDto) {
    return this.adminIdentity.listInvites(query);
  }

  @Post('invites/:inviteId\\:resend')
  @HttpCode(202)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'resendAdminInvite' })
  @apiVersionedJsonResponse(202, adminInviteResendResultSchema)
  async resendInvite(
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @Body() dto: ResendInviteDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.adminIdentity.resendInvite(
      inviteId,
      dto,
      requireIdentityVersion(ifMatch, 'invite', inviteId),
      principal.id,
      principal.role,
      request.requestId,
      requireIdempotencyKey(idempotencyKey),
      request.ip,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('users/:userId/sessions/:sessionId\\:revoke')
  @HttpCode(200)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'revokeAdminUserSession' })
  @apiVersionedJsonResponse(200, adminSessionRevocationResultSchema)
  async revokeSession(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: AdminReasonDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.adminIdentity.revokeSession(
      userId,
      sessionId,
      dto,
      requireIdentityVersion(ifMatch, 'user', userId),
      principal.id,
      principal.role,
      request.requestId,
      requireIdempotencyKey(idempotencyKey),
      request.ip,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('users/:userId/sessions\\:revoke-all')
  @HttpCode(200)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'revokeAllAdminUserSessions' })
  @apiVersionedJsonResponse(200, adminSessionRevocationResultSchema)
  async revokeAllSessions(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.adminIdentity.revokeAllUserSessions(
      userId,
      dto,
      requireIdentityVersion(ifMatch, 'user', userId),
      principal.id,
      principal.role,
      request.requestId,
      requireIdempotencyKey(idempotencyKey),
      request.ip,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('users/:userId/mfa\\:reset')
  @HttpCode(200)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'resetAdminUserMfa' })
  @apiVersionedJsonResponse(200, adminMfaResetResultSchema)
  @apiProblemResponse(409, ['MFA_DISABLED'])
  async resetMfa(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.adminIdentity.resetMfa(
      userId,
      dto,
      requireIdentityVersion(ifMatch, 'user', userId),
      principal.id,
      principal.role,
      request.requestId,
      requireIdempotencyKey(idempotencyKey),
      request.ip,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('users/:userId/password-reset\\:request')
  @HttpCode(202)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'requestAdminUserPasswordReset' })
  @apiVersionedJsonResponse(202, adminPasswordResetRequestResultSchema)
  async requestPasswordReset(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdminReasonDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.adminIdentity.requestPasswordReset(
      userId,
      dto,
      requireIdentityVersion(ifMatch, 'user', userId),
      principal.id,
      principal.role,
      request.requestId,
      requireIdempotencyKey(idempotencyKey),
      request.ip,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }
}
