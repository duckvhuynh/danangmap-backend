import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/http/request-context';
import { apiVersionedJsonResponse } from '../common/openapi/response-schemas';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { requireIdempotencyKey } from '../layers/etag';
import { RollbackDto } from '../layers/layer.dto';
import {
  AuditHistoryQueryDto,
  PublicationHistoryQueryDto,
  RevisionDiffQueryDto,
  RevisionHistoryQueryDto,
  WorkflowHistoryQueryDto,
} from './history.dto';
import { HistoryQueryService } from './history-query.service';
import {
  apiHistoryProblemResponse,
  auditHistoryPageSchema,
  publicationHistoryDetailSchema,
  publicationHistoryPageSchema,
  revisionDiffSchema,
  revisionHistoryDetailSchema,
  revisionHistoryPageSchema,
  rollbackPublicationResultSchema,
  workflowEventPageSchema,
} from './history.schemas';
import { PublicationRollbackService } from './publication-rollback.service';

@ApiTags('admin-history')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
@Roles('editor', 'reviewer', 'publisher', 'system_admin')
@apiHistoryProblemResponse(401, ['AUTH_SESSION_EXPIRED'])
@apiHistoryProblemResponse(403, ['ROLE_FORBIDDEN', 'PASSWORD_CHANGE_REQUIRED'])
export class HistoryController {
  constructor(
    private readonly history: HistoryQueryService,
    private readonly rollbackService: PublicationRollbackService,
  ) {}

  @Get('layers/:layerId/history')
  @ApiOperation({ operationId: 'listLayerRevisionHistory' })
  @apiVersionedJsonResponse(200, revisionHistoryPageSchema)
  @apiHistoryProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiHistoryProblemResponse(404, ['NOT_FOUND'])
  async listRevisions(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Query() query: RevisionHistoryQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.history.listRevisionHistory(layerId, query);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('revisions/:revisionId/history')
  @ApiOperation({ operationId: 'getRevisionHistory' })
  @apiVersionedJsonResponse(200, revisionHistoryDetailSchema)
  @apiHistoryProblemResponse(400, ['BAD_REQUEST'])
  @apiHistoryProblemResponse(404, ['NOT_FOUND'])
  async getRevision(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.history.getRevisionHistory(revisionId);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('revisions/:revisionId/diff')
  @ApiOperation({ operationId: 'getRevisionDiff' })
  @apiVersionedJsonResponse(200, revisionDiffSchema)
  @apiHistoryProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiHistoryProblemResponse(404, ['NOT_FOUND'])
  @apiHistoryProblemResponse(422, ['DIFF_TOO_LARGE'])
  async getDiff(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Query() query: RevisionDiffQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.history.getRevisionDiff(revisionId, query);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('layers/:layerId/publications')
  @ApiOperation({ operationId: 'listLayerPublicationHistory' })
  @apiVersionedJsonResponse(200, publicationHistoryPageSchema)
  @apiHistoryProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiHistoryProblemResponse(404, ['NOT_FOUND'])
  async listPublications(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Query() query: PublicationHistoryQueryDto,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.history.listPublicationHistory(layerId, query, principal);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('publications/:snapshotId')
  @ApiOperation({ operationId: 'getPublicationHistory' })
  @apiVersionedJsonResponse(200, publicationHistoryDetailSchema)
  @apiHistoryProblemResponse(400, ['BAD_REQUEST'])
  @apiHistoryProblemResponse(404, ['NOT_FOUND'])
  async getPublication(
    @Param('snapshotId', ParseUUIDPipe) snapshotId: string,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.history.getPublicationHistory(snapshotId, principal);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('audit-events')
  @Roles('system_admin')
  @ApiOperation({ operationId: 'listAuditEvents' })
  @apiVersionedJsonResponse(200, auditHistoryPageSchema)
  @apiHistoryProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiHistoryProblemResponse(422, ['VALIDATION_FAILED'])
  async listAuditEvents(
    @Query() query: AuditHistoryQueryDto,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.history.listAuditHistory(query, principal);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('layers/:layerId/audit-events')
  @ApiOperation({ operationId: 'listLayerAuditEvents' })
  @apiVersionedJsonResponse(200, auditHistoryPageSchema)
  @apiHistoryProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiHistoryProblemResponse(404, ['NOT_FOUND'])
  @apiHistoryProblemResponse(422, ['VALIDATION_FAILED'])
  async listLayerAuditEvents(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Query() query: AuditHistoryQueryDto,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.history.listAuditHistory(query, principal, layerId);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('revisions/:revisionId/workflow-events')
  @ApiOperation({ operationId: 'listRevisionWorkflowEvents' })
  @apiVersionedJsonResponse(200, workflowEventPageSchema)
  @apiHistoryProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiHistoryProblemResponse(404, ['NOT_FOUND'])
  async listRevisionWorkflowEvents(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Query() query: WorkflowHistoryQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.history.listWorkflowEvents(revisionId, query);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('layers/:layerId\\:rollback')
  @Roles('publisher')
  @UseGuards(CsrfGuard)
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'activePointerEtag from listLayerPublicationHistory.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'rollbackLayer' })
  @apiVersionedJsonResponse(201, rollbackPublicationResultSchema)
  @apiHistoryProblemResponse(403, [
    'ROLE_FORBIDDEN',
    'PASSWORD_CHANGE_REQUIRED',
    'CSRF_INVALID',
    'SEPARATION_OF_DUTIES',
  ])
  @apiHistoryProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiHistoryProblemResponse(404, ['NOT_FOUND', 'ROLLBACK_TARGET_NOT_FOUND'])
  @apiHistoryProblemResponse(409, [
    'IDEMPOTENCY_IN_PROGRESS',
    'IDEMPOTENCY_KEY_REUSED',
    'ROLLBACK_TARGET_ACTIVE',
    'ROLLBACK_TARGET_INVALID',
    'PUBLICATION_POINTER_STALE',
  ])
  @apiHistoryProblemResponse(412, ['ETAG_MISMATCH'])
  @apiHistoryProblemResponse(428, ['ETAG_REQUIRED', 'IDEMPOTENCY_KEY_REQUIRED'])
  async rollback(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Body() dto: RollbackDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.rollbackService.rollback(
      layerId,
      dto,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }
}
