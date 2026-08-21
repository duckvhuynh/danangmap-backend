import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RequestWithContext } from './request-context';

interface ExceptionBody {
  code?: string;
  message?: string | string[];
  details?: Record<string, unknown>;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithContext>();
    const response = context.getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException
        ? exception.getResponse()
        : { message: 'Internal server error' };
    const body: ExceptionBody =
      typeof exceptionResponse === 'string' ? { message: exceptionResponse } : exceptionResponse;
    const validationMessages = Array.isArray(body.message) ? body.message : undefined;
    const message = validationMessages
      ? 'Dữ liệu gửi lên không hợp lệ.'
      : body.message ||
        (status === 500 ? 'Hệ thống tạm thời gặp sự cố.' : 'Yêu cầu không thể xử lý.');
    const code =
      body.code || (validationMessages ? 'VALIDATION_FAILED' : this.codeForStatus(status));
    const requestId =
      request.requestId ?? response.getHeader('X-Request-Id')?.toString() ?? 'unknown';

    if (status >= 500) {
      this.logger.error(
        JSON.stringify({
          event: 'http.request.failed',
          requestId,
          method: request.method,
          path: this.safePath(request),
          status,
          error: exception instanceof Error ? exception.name : 'UnknownError',
        }),
      );
    }

    response
      .status(status)
      .type('application/problem+json')
      .json({
        type: `https://api.danangmap.vn/problems/${code.toLowerCase().replaceAll('_', '-')}`,
        title: this.titleForStatus(status),
        status,
        code,
        message,
        details: validationMessages
          ? {
              violations: validationMessages.map((violation) => ({
                path: '',
                code: 'INVALID_VALUE',
                message: violation,
              })),
            }
          : (body.details ?? {}),
        requestId,
        timestamp: new Date().toISOString(),
      });
  }

  private codeForStatus(status: number): string {
    return (
      {
        400: 'BAD_REQUEST',
        401: 'AUTH_SESSION_EXPIRED',
        403: 'ROLE_FORBIDDEN',
        404: 'NOT_FOUND',
        409: 'CONFLICT',
        412: 'ETAG_MISMATCH',
        413: 'RESOURCE_LIMIT_EXCEEDED',
        422: 'VALIDATION_FAILED',
        428: 'PRECONDITION_REQUIRED',
        429: 'RATE_LIMITED',
      }[status] ?? 'INTERNAL_ERROR'
    );
  }

  private titleForStatus(status: number): string {
    return status >= 500 ? 'Lỗi hệ thống' : 'Không thể xử lý yêu cầu';
  }

  private safePath(request: Request): string {
    return request.path;
  }
}
