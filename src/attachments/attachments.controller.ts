import {
  Body,
  applyDecorators,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { RawResponse } from '../common/http/raw-response.decorator';
import type { RequestWithContext } from '../common/http/request-context';
import {
  apiBinaryResponse,
  apiJsonResponse,
  apiVersionedJsonResponse,
  featureMutationResultSchema,
} from '../common/openapi/response-schemas';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { requireIdempotencyKey } from '../layers/etag';
import {
  BindAttachmentDto,
  CreateAttachmentUploadDto,
  ReorderAttachmentsDto,
} from './attachment.dto';
import {
  attachmentDeleteSchema,
  attachmentMetadataSchema,
  attachmentUploadIntentSchema,
} from './attachment.schemas';
import { AttachmentsService } from './attachments.service';

const mutationHeaders = () =>
  applyDecorators(
    ApiHeader({ name: 'If-Match', required: true, description: 'Revision ETag.' }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiHeader({ name: 'X-CSRF-Token', required: true }),
  );

@ApiTags('attachments')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
export class AdminAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post('uploads')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['purpose', 'fileName', 'contentType', 'sizeBytes', 'sha256'],
      properties: {
        purpose: { type: 'string', enum: ['feature_attachment'] },
        fileName: { type: 'string', maxLength: 255 },
        contentType: { type: 'string' },
        sizeBytes: { type: 'integer', minimum: 1, maximum: 25 * 1024 * 1024 },
        sha256: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
      },
    },
  })
  @ApiOperation({ operationId: 'createAttachmentUpload' })
  @apiJsonResponse(201, attachmentUploadIntentSchema)
  createUpload(
    @Body() dto: CreateAttachmentUploadDto,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.attachments.createUpload(dto, principal);
  }

  @Post('uploads/:uploadId\\:complete')
  @HttpCode(202)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'completeAttachmentUpload' })
  @apiJsonResponse(202, attachmentMetadataSchema)
  complete(
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.attachments.complete(uploadId, principal);
  }

  @Get('attachments/:attachmentId')
  @ApiOperation({ operationId: 'getAdminAttachment' })
  @apiJsonResponse(200, attachmentMetadataSchema)
  get(@Param('attachmentId', ParseUUIDPipe) attachmentId: string) {
    return this.attachments.get(attachmentId);
  }

  @Delete('attachments/:attachmentId')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'deleteUnboundAttachment' })
  @apiJsonResponse(200, attachmentDeleteSchema)
  delete(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.attachments.deleteUnbound(attachmentId, principal);
  }

  @Post('revisions/:revisionId/features/:featureId/attachments\\:bind')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @mutationHeaders()
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['fieldKey', 'attachmentId'],
      properties: {
        fieldKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' },
        attachmentId: { type: 'string', format: 'uuid' },
        displayOrder: { type: 'integer', minimum: 0, maximum: 100_000, default: 0 },
      },
    },
  })
  @ApiOperation({ operationId: 'bindFeatureAttachment' })
  @apiVersionedJsonResponse(200, featureMutationResultSchema)
  async bind(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Body() dto: BindAttachmentDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = (await this.attachments.bind(
      revisionId,
      featureId,
      dto,
      ifMatch,
      idempotencyKey!,
      principal,
      request.requestId,
    )) as { etag: string; feature: unknown; serverCursor: string };
    response.setHeader('ETag', result.etag);
    return { feature: result.feature, serverCursor: result.serverCursor };
  }

  @Patch('revisions/:revisionId/features/:featureId/attachments\\:reorder')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @mutationHeaders()
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['fieldKey', 'attachmentIds'],
      properties: {
        fieldKey: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,63}$' },
        attachmentIds: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: { type: 'string', format: 'uuid' },
        },
      },
    },
  })
  @ApiOperation({ operationId: 'reorderFeatureAttachments' })
  @apiVersionedJsonResponse(200, featureMutationResultSchema)
  async reorder(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Body() dto: ReorderAttachmentsDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = (await this.attachments.reorder(
      revisionId,
      featureId,
      dto.fieldKey,
      dto.attachmentIds,
      ifMatch,
      idempotencyKey!,
      principal,
      request.requestId,
    )) as { etag: string; feature: unknown; serverCursor: string };
    response.setHeader('ETag', result.etag);
    return { feature: result.feature, serverCursor: result.serverCursor };
  }

  @Delete('revisions/:revisionId/features/:featureId/attachments/:attachmentId')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @mutationHeaders()
  @ApiOperation({ operationId: 'unbindFeatureAttachment' })
  @apiVersionedJsonResponse(200, featureMutationResultSchema)
  async unbind(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = (await this.attachments.unbind(
      revisionId,
      featureId,
      attachmentId,
      ifMatch,
      idempotencyKey!,
      principal,
      request.requestId,
    )) as { etag: string; feature: unknown; serverCursor: string };
    response.setHeader('ETag', result.etag);
    return { feature: result.feature, serverCursor: result.serverCursor };
  }
}

@ApiTags('public')
@Controller({ path: 'public', version: '1' })
export class PublicAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('attachments/:attachmentId')
  @RawResponse()
  @ApiOperation({ operationId: 'getPublicAttachment' })
  @ApiHeader({ name: 'If-None-Match', required: false })
  @apiBinaryResponse(200, 'application/octet-stream')
  @ApiResponse({ status: 304, description: 'Not modified.' })
  @ApiResponse({ status: 404, description: 'Not in a public field of the active snapshot.' })
  async get(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    const result = await this.attachments.publicObject(attachmentId);
    response.setHeader('Cache-Control', 'public, no-cache, must-revalidate');
    response.setHeader('ETag', `"attachment-${result.sha256}"`);
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Content-Length', String(result.sizeBytes));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Disposition',
      this.contentDisposition(result.fileName, result.contentType),
    );
    if (request.header('if-none-match') === `"attachment-${result.sha256}"`) {
      result.stream.destroy();
      return response.status(304).end();
    }
    await pipeline(result.stream, response);
  }

  private contentDisposition(fileName: string, contentType: string): string {
    const disposition = contentType.startsWith('image/') ? 'inline' : 'attachment';
    const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  }
}
