import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithContext } from '../common/http/request-context';
import { requireIdempotencyKey } from '../layers/etag';
import {
  apiJsonResponse,
  authPrincipalSchema,
  inviteRevocationSchema,
  inviteResultSchema,
  userCreationResultSchema,
  userListMetaSchema,
} from '../common/openapi/response-schemas';
import { Principal, Roles } from './auth.decorators';
import { CreateInviteDto, CreateUserDto } from './auth.dto';
import { CsrfGuard, RolesGuard, SessionGuard } from './auth.guards';
import { AuthService } from './auth.service';

@ApiTags('admin-users')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get('users')
  @Roles('system_admin')
  @ApiOperation({ operationId: 'listUsers' })
  @apiJsonResponse(200, { type: 'array', items: authPrincipalSchema }, userListMetaSchema)
  async listUsers() {
    return {
      data: await this.auth.listUsers(),
      meta: { nextCursor: null, hasMore: false, limit: 50 },
    };
  }

  @Post('users')
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
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
}
