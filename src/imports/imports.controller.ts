import { FileInterceptor } from '@nestjs/platform-express';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { RequestWithContext } from '../common/http/request-context';
import {
  apiJsonResponse,
  importIssueMetaSchema,
  importIssueSchema,
  importJobSchema,
} from '../common/openapi/response-schemas';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { ApplyImportDto, CreateImportDto, UpdateImportMappingDto } from './import.dto';
import { MAX_IMPORT_BYTES } from './import-file.inspector';
import { ImportUploadGuard } from './import-upload.guard';
import { ImportsService } from './imports.service';

@ApiTags('imports')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post('revisions/:revisionId/imports')
  @HttpCode(202)
  @Roles('editor')
  @UseGuards(CsrfGuard, ImportUploadGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 4 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Revision ETag.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'mode', 'clientRequestId'],
      properties: {
        file: { type: 'string', format: 'binary' },
        format: { type: 'string', enum: ['csv', 'xlsx', 'geojson', 'kml'] },
        mode: { type: 'string', enum: ['append', 'replace', 'upsert'] },
        clientRequestId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiOperation({ operationId: 'createSpatialImport' })
  @apiJsonResponse(202, importJobSchema)
  create(
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: CreateImportDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.create(revisionId, file, dto, ifMatch, idempotencyKey, principal);
  }

  @Get('imports/:importId')
  @Roles('editor', 'system_admin')
  @ApiOperation({ operationId: 'getSpatialImport' })
  @apiJsonResponse(200, importJobSchema)
  get(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.get(importId, principal);
  }

  @Patch('imports/:importId/mapping')
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'updateSpatialImportMapping' })
  @apiJsonResponse(200, importJobSchema)
  mapping(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Body() dto: UpdateImportMappingDto,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.updateMapping(importId, dto, principal);
  }

  @Post('imports/:importId\\:validate')
  @HttpCode(202)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'validateSpatialImport' })
  @apiJsonResponse(202, importJobSchema)
  validate(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.validate(importId, principal);
  }

  @Get('imports/:importId/issues')
  @Roles('editor', 'system_admin')
  @ApiQuery({ name: 'cursor', required: false, type: Number, minimum: 0 })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200 })
  @ApiOperation({ operationId: 'listSpatialImportIssues' })
  @apiJsonResponse(200, { type: 'array', items: importIssueSchema }, importIssueMetaSchema)
  issues(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.issues(importId, cursor, limit, principal);
  }

  @Post('imports/:importId\\:apply')
  @HttpCode(202)
  @Roles('editor')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'If-Match', required: true, description: 'Revision ETag.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'applySpatialImport' })
  @apiJsonResponse(202, importJobSchema)
  apply(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Body() dto: ApplyImportDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.apply(importId, dto, ifMatch, idempotencyKey, request.requestId, principal);
  }
}
