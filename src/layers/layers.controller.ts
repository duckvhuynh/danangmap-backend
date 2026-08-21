import {
  Body,
  Controller,
  Delete,
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
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/http/request-context';
import {
  adminFeatureSchema,
  adminLayerGroupSchema,
  adminLayerListItemSchema,
  apiJsonResponse,
  createLayerResultSchema,
  featureDeleteResultSchema,
  featureMutationResultSchema,
  revisionResultSchema,
  revisionWorkspaceSchema,
} from '../common/openapi/response-schemas';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { requireIdempotencyKey } from './etag';
import {
  CreateLayerDto,
  CreateLayerGroupDto,
  FeatureMutationDto,
  UpdateFeatureDto,
} from './layer.dto';
import { LayersService } from './layers.service';

@ApiTags('admin-layers')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
export class LayersController {
  constructor(private readonly layers: LayersService) {}

  @Get('layer-groups')
  @ApiOperation({ operationId: 'listLayerGroups' })
  @apiJsonResponse(200, { type: 'array', items: adminLayerGroupSchema })
  listGroups() {
    return this.layers.listGroups();
  }

  @Post('layer-groups')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'createLayerGroup' })
  @apiJsonResponse(201, adminLayerGroupSchema)
  createGroup(
    @Body() dto: CreateLayerGroupDto,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.layers.createGroup(dto, principal, request.requestId);
  }

  @Get('layers')
  @ApiOperation({ operationId: 'listAdminLayers' })
  @apiJsonResponse(200, { type: 'array', items: adminLayerListItemSchema })
  listLayers() {
    return this.layers.listLayers();
  }

  @Post('layers')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'createLayer' })
  @apiJsonResponse(201, createLayerResultSchema)
  async createLayer(
    @Body() dto: CreateLayerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.layers.createLayer(dto, principal, request.requestId);
    response.setHeader('ETag', result.etag);
    return { layer: result.layer, draftRevision: result.draftRevision };
  }

  @Get('revisions/:revisionId')
  @ApiOperation({ operationId: 'getRevision' })
  @apiJsonResponse(200, revisionResultSchema)
  async getRevision(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.layers.getRevision(revisionId);
    response.setHeader('ETag', result.etag);
    return { revision: result.revision, fields: result.fields };
  }

  @Get('revisions/:revisionId/workspace')
  @ApiOperation({ operationId: 'getRevisionWorkspace' })
  @apiJsonResponse(200, revisionWorkspaceSchema)
  async workspace(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.layers.workspace(revisionId);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('revisions/:revisionId/features')
  @ApiOperation({ operationId: 'listAdminFeatures' })
  @apiJsonResponse(200, { type: 'array', items: adminFeatureSchema })
  listFeatures(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Query('bbox') bbox?: string,
    @Query('limit') limit = 200,
  ) {
    return this.layers.listFeatures(revisionId, bbox, Number(limit));
  }

  @Post('revisions/:revisionId/features')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true, description: 'Revision ETag.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'createFeature' })
  @apiJsonResponse(201, featureMutationResultSchema)
  async createFeature(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: FeatureMutationDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.layers.createFeature(
      revisionId,
      dto,
      ifMatch,
      principal,
      request.requestId,
    );
    response.setHeader('ETag', result.etag);
    return { feature: result.feature, serverCursor: result.serverCursor };
  }

  @Patch('revisions/:revisionId/features/:featureId')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true, description: 'Revision ETag.' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'updateFeature' })
  @apiJsonResponse(200, featureMutationResultSchema)
  async updateFeature(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Body() dto: UpdateFeatureDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.layers.updateFeature(
      revisionId,
      featureId,
      dto,
      ifMatch,
      principal,
      request.requestId,
    );
    response.setHeader('ETag', result.etag);
    return { feature: result.feature, serverCursor: result.serverCursor };
  }

  @Delete('revisions/:revisionId/features/:featureId')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true, description: 'Revision ETag.' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'deleteFeature' })
  @apiJsonResponse(200, featureDeleteResultSchema)
  async deleteFeature(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.layers.deleteFeature(
      revisionId,
      featureId,
      ifMatch,
      principal,
      request.requestId,
    );
    response.setHeader('ETag', result.etag);
    return result;
  }
}
