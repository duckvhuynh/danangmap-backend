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
import {
  apiJsonResponse,
  userImportIssueMetaSchema,
  userImportIssueSchema,
  userImportJobSchema,
  userImportReportSchema,
} from '../common/openapi/response-schemas';
import type { RequestWithContext } from '../common/http/request-context';
import { Principal, Roles } from '../identity/auth.decorators';
import { CsrfGuard, RolesGuard, SessionGuard } from '../identity/auth.guards';
import { ApplyUserImportDto, ValidateUserImportDto } from './user-import.dto';
import { UserImportsService } from './user-imports.service';
import { MAX_USER_IMPORT_BYTES, UserImportUploadGuard } from './user-import-upload.guard';

@ApiTags('admin-user-imports')
@ApiCookieAuth('adminSession')
@Controller({ path: 'admin/user-imports', version: '1' })
@UseGuards(SessionGuard, RolesGuard)
export class UserImportsController {
  constructor(private readonly imports: UserImportsService) {}

  @Post()
  @HttpCode(202)
  @Roles('system_admin')
  @UseGuards(CsrfGuard, UserImportUploadGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_USER_IMPORT_BYTES, files: 1, fields: 0 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ operationId: 'createUserImport' })
  @apiJsonResponse(202, userImportJobSchema)
  create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.create(file, idempotencyKey, principal);
  }

  @Get(':importId')
  @Roles('system_admin')
  @ApiOperation({ operationId: 'getUserImport' })
  @apiJsonResponse(200, userImportJobSchema)
  get(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.get(importId, principal);
  }

  @Post(':importId\\:validate')
  @HttpCode(202)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'validateUserImport' })
  @apiJsonResponse(202, userImportJobSchema)
  validate(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Body() dto: ValidateUserImportDto,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.validate(importId, dto, principal);
  }

  @Post(':importId\\:apply')
  @HttpCode(202)
  @Roles('system_admin')
  @UseGuards(CsrfGuard)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ operationId: 'applyUserImport' })
  @apiJsonResponse(202, userImportJobSchema)
  apply(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Body() dto: ApplyUserImportDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.apply(importId, dto, idempotencyKey, request.requestId, principal);
  }

  @Get(':importId/issues')
  @Roles('system_admin')
  @ApiQuery({ name: 'cursor', required: false, type: String, pattern: '^\\d+$' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200 })
  @ApiQuery({ name: 'code', required: false, type: String, pattern: '^[A-Z][A-Z0-9_]{2,99}$' })
  @ApiOperation({ operationId: 'listUserImportIssues' })
  @apiJsonResponse(200, { type: 'array', items: userImportIssueSchema }, userImportIssueMetaSchema)
  issues(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('code') code: string | undefined,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.issues(importId, { cursor, limit, code }, principal);
  }

  @Get(':importId/report')
  @Roles('system_admin')
  @ApiQuery({ name: 'cursor', required: false, type: String, pattern: '^\\d+$' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 200 })
  @ApiQuery({ name: 'code', required: false, type: String, pattern: '^[A-Z][A-Z0-9_]{2,99}$' })
  @ApiOperation({ operationId: 'getUserImportReport' })
  @apiJsonResponse(200, userImportReportSchema, userImportIssueMetaSchema)
  report(
    @Param('importId', ParseUUIDPipe) importId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('code') code: string | undefined,
    @Principal() principal: NonNullable<RequestWithContext['principal']>,
  ) {
    return this.imports.report(importId, { cursor, limit, code }, principal);
  }
}
