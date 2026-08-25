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
  Put,
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
import {
  adminFeatureSchema,
  adminLayerDetailSchema,
  adminLayerGroupSchema,
  adminLayerListItemSchema,
  apiJsonResponse,
  apiVersionedJsonResponse,
  catalogReorderResultSchema,
  createLayerResultSchema,
  featureDeleteResultSchema,
  featureBatchSyncSchema,
  featureMutationResultSchema,
  revisionChangeMetaSchema,
  revisionChangeSchema,
  revisionResultSchema,
  revisionConfigurationImpactSchema,
  revisionConfigurationResultSchema,
  revisionWorkspaceSchema,
  successorDraftResultSchema,
} from '../common/openapi/response-schemas';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { requireIdempotencyKey, resourceEtag } from './etag';
import { LayerCatalogService } from './layer-catalog.service';
import {
  ArchiveLayerGroupDto,
  CreateLayerDto,
  CreateLayerGroupDto,
  FeatureMutationDto,
  FeatureBatchSyncDto,
  FeatureChangeFeedQueryDto,
  ListCatalogQueryDto,
  ReorderCatalogDto,
  RevisionConfigurationDto,
  UpdateLayerDto,
  UpdateLayerGroupDto,
  UpdateFeatureDto,
} from './layer.dto';
import { LayersService } from './layers.service';
import { RevisionConfigurationService } from './revision-configuration.service';
import { FeatureSyncService } from './feature-sync.service';

@ApiTags('admin-layers')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
export class LayersController {
  constructor(
    private readonly layers: LayersService,
    private readonly catalog: LayerCatalogService,
    private readonly revisionConfiguration: RevisionConfigurationService,
    private readonly featureSync: FeatureSyncService,
  ) {}

  @Get('layer-groups')
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @ApiOperation({ operationId: 'listLayerGroups' })
  @apiVersionedJsonResponse(200, { type: 'array', items: adminLayerGroupSchema })
  async listGroups(
    @Query() query: ListCatalogQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.catalog.listGroups(query.includeArchived === 'true');
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('layer-groups')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'createLayerGroup' })
  @apiVersionedJsonResponse(201, adminLayerGroupSchema)
  async createGroup(
    @Body() dto: CreateLayerGroupDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const group = await this.layers.createGroup(dto, principal, request.requestId, idempotencyKey!);
    response.setHeader('ETag', resourceEtag('layer-group', group.id, group.lockVersion));
    return group;
  }

  @Get('layer-groups/:groupId')
  @ApiOperation({ operationId: 'getLayerGroup' })
  @apiVersionedJsonResponse(200, adminLayerGroupSchema)
  async getGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.catalog.getGroup(groupId);
    response.setHeader('ETag', result.etag);
    return result.group;
  }

  @Patch('layer-groups/:groupId')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'updateLayerGroup' })
  @apiVersionedJsonResponse(200, adminLayerGroupSchema)
  async updateGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: UpdateLayerGroupDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.catalog.updateGroup(
      groupId,
      dto,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.group;
  }

  @Post('layer-groups\\:reorder')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true, description: 'ETag from listLayerGroups.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'reorderLayerGroups' })
  @apiVersionedJsonResponse(200, catalogReorderResultSchema)
  async reorderGroups(
    @Body() dto: ReorderCatalogDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.catalog.reorderGroups(
      dto,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('layer-groups/:groupId\\:archive')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'archiveLayerGroup' })
  @apiVersionedJsonResponse(200, adminLayerGroupSchema)
  async archiveGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: ArchiveLayerGroupDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.catalog.archiveGroup(
      groupId,
      dto,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.group;
  }

  @Get('layers')
  @ApiQuery({ name: 'includeArchived', required: false, type: Boolean })
  @ApiOperation({ operationId: 'listAdminLayers' })
  @apiVersionedJsonResponse(200, { type: 'array', items: adminLayerListItemSchema })
  async listLayers(
    @Query() query: ListCatalogQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.catalog.listLayers(query.includeArchived === 'true');
    response.setHeader('ETag', result.etag);
    return result.data;
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
  @apiVersionedJsonResponse(201, createLayerResultSchema)
  async createLayer(
    @Body() dto: CreateLayerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.layers.createLayer(
      dto,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return { layer: result.layer, draftRevision: result.draftRevision };
  }

  @Get('layers/:layerId')
  @ApiOperation({ operationId: 'getAdminLayer' })
  @apiVersionedJsonResponse(200, adminLayerDetailSchema)
  async getLayer(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.catalog.getLayer(layerId);
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Patch('layers/:layerId')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'updateLayerCatalogConfig' })
  @apiVersionedJsonResponse(200, adminLayerDetailSchema)
  async updateLayer(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Body() dto: UpdateLayerDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.catalog.updateLayer(
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

  @Post('layers\\:reorder')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true, description: 'ETag from listAdminLayers.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'reorderLayers' })
  @apiVersionedJsonResponse(200, catalogReorderResultSchema)
  async reorderLayers(
    @Body() dto: ReorderCatalogDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.catalog.reorderLayers(
      dto,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('layers/:layerId\\:archive')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'archiveLayer' })
  @apiVersionedJsonResponse(200, adminLayerDetailSchema)
  async archiveLayer(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.catalog.setLayerArchived(
      layerId,
      true,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('layers/:layerId\\:unarchive')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'unarchiveLayer' })
  @apiVersionedJsonResponse(200, adminLayerDetailSchema)
  async unarchiveLayer(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.catalog.setLayerArchived(
      layerId,
      false,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Post('layers/:layerId/drafts')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true, description: 'ETag of the published revision.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'createSuccessorDraft' })
  @apiVersionedJsonResponse(201, successorDraftResultSchema)
  async createSuccessorDraft(
    @Param('layerId', ParseUUIDPipe) layerId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.revisionConfiguration.createSuccessorDraft(
      layerId,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('revisions/:revisionId')
  @ApiOperation({ operationId: 'getRevision' })
  @apiVersionedJsonResponse(200, revisionResultSchema)
  async getRevision(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.layers.getRevision(revisionId);
    response.setHeader('ETag', result.etag);
    return { revision: result.revision, fields: result.fields };
  }

  @Post('revisions/:revisionId/config\\:impact')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'previewRevisionConfigurationImpact' })
  @apiVersionedJsonResponse(200, revisionConfigurationImpactSchema)
  async previewRevisionConfigImpact(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: RevisionConfigurationDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.revisionConfiguration.preview(revisionId, dto, ifMatch);
    response.setHeader('ETag', result.etag);
    return result.impact;
  }

  @Put('revisions/:revisionId/config')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'replaceDraftRevisionConfiguration' })
  @apiVersionedJsonResponse(200, revisionConfigurationResultSchema)
  async replaceRevisionConfig(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: RevisionConfigurationDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.revisionConfiguration.replace(
      revisionId,
      dto,
      ifMatch,
      principal,
      request.requestId,
      idempotencyKey!,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('revisions/:revisionId/workspace')
  @ApiOperation({ operationId: 'getRevisionWorkspace' })
  @apiVersionedJsonResponse(200, revisionWorkspaceSchema)
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
  @apiVersionedJsonResponse(201, featureMutationResultSchema)
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
      idempotencyKey!,
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
  @apiVersionedJsonResponse(200, featureMutationResultSchema)
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
  @apiVersionedJsonResponse(200, featureDeleteResultSchema)
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

  @Post('revisions/:revisionId/changes\\:batch')
  @HttpCode(200)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiSecurity({ adminSession: [], csrf: [] })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Revision ETag at batch start.' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'syncFeatureChangesBatch' })
  @apiVersionedJsonResponse(200, featureBatchSyncSchema)
  async syncFeatureChangesBatch(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: FeatureBatchSyncDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    const result = await this.featureSync.syncBatch(
      revisionId,
      dto,
      ifMatch,
      principal,
      request.requestId,
    );
    response.setHeader('ETag', result.etag);
    return result.data;
  }

  @Get('revisions/:revisionId/changes')
  @ApiQuery({ name: 'after', required: true, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 500 })
  @ApiOperation({ operationId: 'listRevisionChanges' })
  @apiVersionedJsonResponse(
    200,
    { type: 'array', items: revisionChangeSchema },
    revisionChangeMetaSchema,
  )
  async listRevisionChanges(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Query() query: FeatureChangeFeedQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.featureSync.changes(revisionId, query.after, query.limit);
    response.setHeader('ETag', result.etag);
    return { data: result.data, meta: result.meta };
  }
}
