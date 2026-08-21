import { Body, Controller, Get, Headers, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppException } from '../common/http/app.exception';
import type { RequestWithContext } from '../common/http/request-context';
import {
  apiJsonResponse,
  authPrincipalSchema,
  genericObjectSchema,
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
  @apiJsonResponse(200, { type: 'array', items: authPrincipalSchema }, genericObjectSchema)
  async listUsers() {
    return {
      data: await this.auth.listUsers(),
      meta: { nextCursor: null, hasMore: false, limit: 50 },
    };
  }

  @Post('users')
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiOperation({ operationId: 'createUser' })
  @apiJsonResponse(201, genericObjectSchema)
  async createUser(
    @Body() dto: CreateUserDto,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.auth.createUser(dto, principal.id, principal.role, request.requestId);
  }

  @Post('invites')
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiOperation({ operationId: 'createInvite' })
  @apiJsonResponse(201, genericObjectSchema)
  async createInvite(
    @Body() dto: CreateInviteDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    if (!idempotencyKey) {
      throw new AppException(428, 'IDEMPOTENCY_KEY_REQUIRED', 'Thiếu Idempotency-Key.');
    }
    return this.auth.createInvite(dto, principal.id, principal.role, request.requestId);
  }
}
