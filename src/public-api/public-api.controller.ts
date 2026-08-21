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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RawResponse } from '../common/http/raw-response.decorator';
import type { RequestWithContext } from '../common/http/request-context';
import { PublicApiService } from './public-api.service';

@ApiTags('public')
@Controller('public')
export class PublicApiController {
  constructor(private readonly publicApi: PublicApiService) {}

  @Get('layers')
  @ApiOperation({ operationId: 'listPublicLayers' })
  async catalog(@Req() request: RequestWithContext, @Res() response: Response) {
    const result = await this.publicApi.catalog();
    return this.cacheableJson(request, response, result.data, result.etag, 60);
  }

  @Get('layers/:slug')
  @ApiOperation({ operationId: 'getPublicLayer' })
  async layer(
    @Param('slug') slug: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    const result = await this.publicApi.layerDetail(slug);
    return this.cacheableJson(request, response, result.data, result.etag, 60);
  }

  @Get('layers/:slug/features')
  @RawResponse()
  @ApiOperation({ operationId: 'listPublicFeatures' })
  async features(
    @Param('slug') slug: string,
    @Query('bbox') bbox: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('filter') filter: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return this.publicApi.featureCollection(slug, bbox, limit ? Number(limit) : 1000, filter);
  }

  @Get('layers/:slug/features/:featureId')
  @ApiOperation({ operationId: 'getPublicFeature' })
  async feature(
    @Param('slug') slug: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    const result = await this.publicApi.feature(slug, featureId);
    return this.cacheableJson(request, response, result.data, result.etag, 300);
  }

  @Get('tiles/:slug/:generation/:z/:x/:y.pbf')
  @RawResponse()
  @ApiOperation({ operationId: 'getPublicTile' })
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
  place(@Param('placeId') placeId: string, @Query('fields') fields?: string) {
    return this.publicApi.placeDetails(placeId, fields);
  }

  private cacheableJson(
    request: RequestWithContext,
    response: Response,
    data: unknown,
    etag: string,
    maxAge: number,
  ) {
    response.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=300`);
    response.setHeader('ETag', etag);
    if (request.header('if-none-match') === etag) return response.status(304).end();
    return response.status(200).json({ data, meta: { requestId: request.requestId } });
  }
}
