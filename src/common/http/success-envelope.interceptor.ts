import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { RequestWithContext } from './request-context';
import { RAW_RESPONSE_KEY } from './raw-response.decorator';

interface EnvelopeAware {
  data?: unknown;
  meta?: Record<string, unknown>;
}

@Injectable()
export class SuccessEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    return next.handle().pipe(
      map((value: unknown) => {
        const object = value && typeof value === 'object' ? (value as EnvelopeAware) : undefined;
        if (object && 'data' in object) {
          return {
            ...object,
            meta: { ...(object.meta ?? {}), requestId: request.requestId },
          };
        }
        return { data: value ?? null, meta: { requestId: request.requestId } };
      }),
    );
  }
}
