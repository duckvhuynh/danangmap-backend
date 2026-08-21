import { FileInterceptor } from '@nestjs/platform-express';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { RequestWithContext } from '../common/http/request-context';
import { apiJsonResponse, importJobSchema } from '../common/openapi/response-schemas';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { CreateImportDto } from './import.dto';
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
}
