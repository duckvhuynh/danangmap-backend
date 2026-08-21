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
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/http/request-context';
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
  listGroups() {
    return this.layers.listGroups();
  }

  @Post('layer-groups')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiOperation({ operationId: 'createLayerGroup' })
  createGroup(
    @Body() dto: CreateLayerGroupDto,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.layers.createGroup(dto, principal, request.requestId);
  }

  @Get('layers')
  @ApiOperation({ operationId: 'listAdminLayers' })
  listLayers() {
    return this.layers.listLayers();
  }

  @Post('layers')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiOperation({ operationId: 'createLayer' })
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
  @ApiOperation({ operationId: 'createFeature' })
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
  @ApiOperation({ operationId: 'updateFeature' })
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
  @ApiOperation({ operationId: 'deleteFeature' })
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
