import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/http/request-context';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { requireIdempotencyKey } from '../layers/etag';
import { PublishRevisionDto } from '../layers/layer.dto';
import { PublicationCommandService } from './publication-command.service';
import { PublicationJobListQueryDto } from './publication.dto';
import { PublicationQueryService } from './publication-query.service';
import {
  apiPublicationJobResponse,
  apiPublicationNotModifiedResponse,
  apiPublicationProblemResponse,
  apiPublishAcceptedResponse,
  publicationJobPageSchema,
  publicationJobSchema,
} from './publication.schemas';

@ApiTags('publications')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
@Roles('editor', 'reviewer', 'publisher', 'system_admin')
@apiPublicationProblemResponse(401, ['AUTH_SESSION_EXPIRED'])
@apiPublicationProblemResponse(403, ['ROLE_FORBIDDEN', 'PASSWORD_CHANGE_REQUIRED'])
export class PublicationController {
  constructor(
    private readonly command: PublicationCommandService,
    private readonly query: PublicationQueryService,
    private readonly config: ConfigService,
  ) {}

  @Post('revisions/:revisionId\\:publish')
  @HttpCode(202)
  @Roles('publisher')
  @UseGuards(CsrfGuard)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({
    operationId: 'publishRevision',
    description:
      'Uses the legacy atomic synchronous path while ASYNC_PUBLICATION_ENABLED=false. When enabled, clientIntent=desktop is required and the committed queued job is returned.',
  })
  @apiPublishAcceptedResponse()
  @apiPublicationProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiPublicationProblemResponse(403, [
    'ROLE_FORBIDDEN',
    'PASSWORD_CHANGE_REQUIRED',
    'CSRF_INVALID',
    'SEPARATION_OF_DUTIES',
  ])
  @apiPublicationProblemResponse(404, ['NOT_FOUND'])
  @apiPublicationProblemResponse(409, [
    'IDEMPOTENCY_IN_PROGRESS',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_RESPONSE_INCOMPATIBLE',
    'PUBLICATION_BASE_STALE',
    'PUBLICATION_JOB_ACTIVE',
    'WORKFLOW_TRANSITION_INVALID',
  ])
  @apiPublicationProblemResponse(428, ['IDEMPOTENCY_KEY_REQUIRED'])
  async publish(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: PublishRevisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(key);
    const result = await this.command.publish(revisionId, dto, principal, request.requestId, key!);
    if (result.etag) response.setHeader('ETag', result.etag);
    if (result.location) response.setHeader('Location', result.location);
    if (result.retryAfter) response.setHeader('Retry-After', String(result.retryAfter));
    if (result.cacheControl) response.setHeader('Cache-Control', result.cacheControl);
    return result.data;
  }

  @Get('publication-jobs/:jobId')
  @ApiHeader({ name: 'If-None-Match', required: false })
  @ApiOperation({ operationId: 'getPublicationJob' })
  @apiPublicationJobResponse(publicationJobSchema)
  @apiPublicationNotModifiedResponse()
  @apiPublicationProblemResponse(400, ['BAD_REQUEST'])
  @apiPublicationProblemResponse(404, ['NOT_FOUND'])
  async get(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    const result = await this.query.get(jobId);
    return this.sendVersioned(request, response, result.data, result.etag);
  }

  @Get('layers/:layerId/publication-jobs')
  @ApiHeader({ name: 'If-None-Match', required: false })
  @ApiOperation({ operationId: 'listLayerPublicationJobs' })
  @apiPublicationJobResponse(publicationJobPageSchema)
  @apiPublicationNotModifiedResponse()
  @apiPublicationProblemResponse(400, ['BAD_REQUEST', 'VALIDATION_FAILED'])
  @apiPublicationProblemResponse(404, ['NOT_FOUND'])
  async list(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Query() query: PublicationJobListQueryDto,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    const result = await this.query.list(layerId, query);
    return this.sendVersioned(request, response, result.data, result.etag);
  }

  private sendVersioned(
    request: RequestWithContext,
    response: Response,
    data: unknown,
    etag: string,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('ETag', etag);
    if (request.header('if-none-match') === etag) return response.status(304).end();
    if (['queued', 'building'].includes((data as { status?: string }).status ?? '')) {
      const intervalMs = this.config.getOrThrow<number>('publication.dispatchIntervalMs');
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil(intervalMs / 1_000))));
    }
    return response.status(200).json({ data, meta: { requestId: request.requestId } });
  }
}
