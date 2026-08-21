import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RawResponse } from '../common/http/raw-response.decorator';
import type { RequestWithContext } from '../common/http/request-context';
import {
  apiBinaryResponse,
  apiJsonResponse,
  apiRawJsonResponse,
  externalPlaceSchema,
  publicFeatureCollectionSchema,
  publicFeatureDetailSchema,
  publicLayerDetailSchema,
  publicLayerSchema,
  publicSearchItemSchema,
  publicSearchMetaSchema,
} from '../common/openapi/response-schemas';
import { PublicApiService } from './public-api.service';

@ApiTags('public')
@Controller('public')
export class PublicApiController {
  constructor(private readonly publicApi: PublicApiService) {}

  @Get('layers')
  @ApiOperation({ operationId: 'listPublicLayers' })
  @apiJsonResponse(200, { type: 'array', items: publicLayerSchema })
  async catalog(@Req() request: RequestWithContext, @Res() response: Response) {
    const result = await this.publicApi.catalog();
    return this.cacheableJson(request, response, result.data, result.etag);
  }

  @Get('layers/:slug')
  @ApiOperation({ operationId: 'getPublicLayer' })
  @apiJsonResponse(200, publicLayerDetailSchema)
  async layer(
    @Param('slug') slug: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    const result = await this.publicApi.layerDetail(slug);
    return this.cacheableJson(request, response, result.data, result.etag);
  }

  @Get('layers/:slug/features')
  @RawResponse()
  @ApiOperation({ operationId: 'listPublicFeatures' })
  @ApiQuery({ name: 'bbox', required: false, type: String, example: '108.1,15.9,108.4,16.2' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 5000 })
  @ApiQuery({ name: 'filter', required: false, type: String, example: 'type:eq:Phường' })
  @apiRawJsonResponse(200, publicFeatureCollectionSchema)
  async features(
    @Param('slug') slug: string,
    @Query('bbox') bbox: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('filter') filter: string | undefined,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    const result = await this.publicApi.featureCollection(
      slug,
      bbox,
      limit ? Number(limit) : 1000,
      filter,
    );
    response.setHeader('Cache-Control', 'public, no-cache, must-revalidate');
    response.setHeader('ETag', result.etag);
    if (request.header('if-none-match') === result.etag) return response.status(304).end();
    return response.status(200).json(result.data);
  }

  @Get('layers/:slug/features/:featureId')
  @ApiOperation({ operationId: 'getPublicFeature' })
  @apiJsonResponse(200, publicFeatureDetailSchema)
  async feature(
    @Param('slug') slug: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    const result = await this.publicApi.feature(slug, featureId);
    return this.cacheableJson(request, response, result.data, result.etag);
  }

  @Get('tiles/:slug/:generation/:z/:x/:y.pbf')
  @RawResponse()
  @ApiOperation({ operationId: 'getPublicTile' })
  @apiBinaryResponse(200, 'application/vnd.mapbox-vector-tile')
  async tile(
    @Param('slug') slug: string,
    @Param('generation', ParseIntPipe) generation: number,
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const result = await this.publicApi.tile(slug, generation, z, x, y);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
    response.setHeader('ETag', result.etag);
    if (request.header('if-none-match') === result.etag) return response.status(304).end();
    return response.status(200).send(result.tile);
  }

  @Get('search')
  @ApiOperation({ operationId: 'searchPublicMap' })
  @ApiQuery({ name: 'q', required: true, type: String, minLength: 2, maxLength: 200 })
  @ApiQuery({ name: 'sources', required: false, type: String, example: 'internal,place' })
  @ApiQuery({
    name: 'layerIds',
    required: false,
    type: String,
    description: 'Comma-separated UUIDs; tối đa 20 layer.',
  })
  @ApiQuery({ name: 'center', required: false, type: String, example: '16.0544,108.2022' })
  @ApiQuery({ name: 'radiusM', required: false, type: Number, minimum: 1, maximum: 50000 })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 30 })
  @apiJsonResponse(200, { type: 'array', items: publicSearchItemSchema }, publicSearchMetaSchema)
  search(
    @Query('q') q: string,
    @Query('sources') sources?: string,
    @Query('layerIds') layerIds?: string,
    @Query('center') center?: string,
    @Query('radiusM') radiusM?: string,
    @Query('limit') limit?: string,
  ) {
    return this.publicApi.search({
      q: q ?? '',
      sources,
      layerIds,
      center,
      radiusM: radiusM === undefined ? undefined : Number(radiusM),
      limit: limit === undefined ? undefined : Number(limit),
    });
  }

  @Get('places/:placeId')
  @ApiOperation({ operationId: 'getExternalPlace' })
  @ApiQuery({ name: 'fields', required: false, type: String, example: 'name,address,position' })
  @apiJsonResponse(200, externalPlaceSchema)
  place(@Param('placeId') placeId: string, @Query('fields') fields?: string) {
    return this.publicApi.placeDetails(placeId, fields);
  }

  private cacheableJson(
    request: RequestWithContext,
    response: Response,
    data: unknown,
    etag: string,
  ) {
    // Pointer-resolving URLs must revalidate so a publish/rollback cannot be served stale.
    // Generation-addressed vector tiles remain immutable and cacheable for one year.
    response.setHeader('Cache-Control', 'public, no-cache, must-revalidate');
    response.setHeader('ETag', etag);
    if (request.header('if-none-match') === etag) return response.status(304).end();
    return response.status(200).json({ data, meta: { requestId: request.requestId } });
  }
}
