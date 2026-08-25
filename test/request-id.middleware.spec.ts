import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { RequestIdMiddleware } from '../src/common/http/request-id.middleware';
import type { RequestWithContext } from '../src/common/http/request-context';

describe('RequestIdMiddleware', () => {
  it('emits a bounded structured completion log without request secrets', () => {
    const logger = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const response = new EventEmitter() as EventEmitter &
      Pick<Response, 'once' | 'setHeader' | 'statusCode'>;
    response.statusCode = 201;
    response.setHeader = jest.fn();
    const request = {
      method: 'POST',
      path: '/api/v1/auth/bootstrap/system-admin',
      originalUrl: '/api/v1/auth/bootstrap/system-admin?token=must-not-log',
      body: { password: 'must-not-log', bootstrapToken: 'must-not-log' },
      header: jest.fn().mockReturnValue('be19e6dd-39e4-4ab0-9e9e-720036924bcf'),
    } as unknown as RequestWithContext;
    const next = jest.fn() as NextFunction;

    new RequestIdMiddleware().use(request, response as unknown as Response, next);
    response.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Request-Id',
      'be19e6dd-39e4-4ab0-9e9e-720036924bcf',
    );
    const payload = JSON.parse(logger.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: 'http.request.completed',
      requestId: 'be19e6dd-39e4-4ab0-9e9e-720036924bcf',
      method: 'POST',
      path: '/api/v1/auth/bootstrap/system-admin',
      statusCode: 201,
    });
    expect(payload.durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(payload)).not.toContain('must-not-log');
  });
});
