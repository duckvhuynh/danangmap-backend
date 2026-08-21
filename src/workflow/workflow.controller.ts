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
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithContext } from '../common/http/request-context';
import { apiJsonResponse, workflowResultSchema } from '../common/openapi/response-schemas';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { requireIdempotencyKey } from '../layers/etag';
import {
  PublishRevisionDto,
  RequestChangesDto,
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
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'submitRevision' })
  @apiJsonResponse(202, workflowResultSchema)
  submit(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: SubmitRevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.submit(revisionId, dto, principal, request.requestId, key!);
  }

  @Post('revisions/:revisionId\\:approve')
  @Roles('reviewer')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'approveRevision' })
  @apiJsonResponse(201, workflowResultSchema)
  approve(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: WorkflowCommentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.approve(revisionId, dto, principal, request.requestId, key!);
  }

  @Post('revisions/:revisionId\\:request-changes')
  @Roles('reviewer')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'requestRevisionChanges' })
  @apiJsonResponse(201, workflowResultSchema)
  requestChanges(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: RequestChangesDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.requestChanges(revisionId, dto, principal, request.requestId, key!);
  }

  @Post('revisions/:revisionId\\:publish')
  @HttpCode(202)
  @Roles('publisher')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'publishRevision' })
  @apiJsonResponse(202, workflowResultSchema)
  publish(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: PublishRevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    return this.workflow.publish(revisionId, dto, principal, request.requestId, key!);
  }
}
