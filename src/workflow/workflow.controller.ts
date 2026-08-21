import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithContext } from '../common/http/request-context';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { requireIdempotencyKey } from '../layers/etag';
import {
  PublishRevisionDto,
  RequestChangesDto,
  RollbackDto,
  SubmitRevisionDto,
  WorkflowCommentDto,
} from '../layers/layer.dto';
import { WorkflowService } from './workflow.service';

@ApiTags('workflow')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard, CsrfGuard)
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Post('revisions/:revisionId\\:submit')
  @HttpCode(202)
  @Roles('editor')
  @ApiOperation({ operationId: 'submitRevision' })
  submit(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: SubmitRevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.submit(revisionId, dto, principal, request.requestId);
  }

  @Post('revisions/:revisionId\\:approve')
  @Roles('reviewer')
  @ApiOperation({ operationId: 'approveRevision' })
  approve(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: WorkflowCommentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.approve(revisionId, dto, principal, request.requestId);
  }

  @Post('revisions/:revisionId\\:request-changes')
  @Roles('reviewer')
  @ApiOperation({ operationId: 'requestRevisionChanges' })
  requestChanges(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: RequestChangesDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.requestChanges(revisionId, dto, principal, request.requestId);
  }

  @Post('revisions/:revisionId\\:publish')
  @HttpCode(202)
  @Roles('publisher')
  @ApiOperation({ operationId: 'publishRevision' })
  publish(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: PublishRevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.publish(revisionId, dto, principal, request.requestId);
  }

  @Post('layers/:layerId\\:rollback')
  @Roles('publisher')
  @ApiOperation({ operationId: 'rollbackLayer' })
  rollback(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Body() dto: RollbackDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.rollback(layerId, dto, principal, request.requestId);
  }
}
