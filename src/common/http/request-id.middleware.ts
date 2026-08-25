import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { RequestWithContext } from './request-context';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestIdMiddleware.name);

  use(request: RequestWithContext, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const candidate = request.header('x-request-id');
    request.requestId = candidate && uuidPattern.test(candidate) ? candidate : randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    response.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.logger.log(
        JSON.stringify({
          event: 'http.request.completed',
          requestId: request.requestId,
          method: request.method,
          path: request.path,
          statusCode: response.statusCode,
          durationMs: Number(durationMs.toFixed(3)),
        }),
      );
    });
    next();
  }
}
