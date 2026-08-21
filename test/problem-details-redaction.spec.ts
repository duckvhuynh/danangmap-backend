import { type ArgumentsHost, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemDetailsFilter } from '../src/common/http/problem-details.filter';
import type { RequestWithContext } from '../src/common/http/request-context';

describe('ProblemDetailsFilter secret redaction', () => {
  it('does not emit exception messages or MFA material to logs or responses', () => {
    const sensitive = 'otpauth://totp/DanangMap:user?secret=RAWSECRET recovery=AAAA-BBBB';
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const request = {
      method: 'POST',
      path: '/api/v1/auth/mfa/enroll/confirm',
      requestId: 'test-request-id',
    } as RequestWithContext;
    const json = jest.fn();
    const response = {
      getHeader: jest.fn().mockReturnValue(undefined),
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      json,
    } as unknown as Response;
    const host = {
      switchToHttp: () => ({
        getRequest: <T = Request>() => request as T,
        getResponse: <T = Response>() => response as T,
        getNext: <T = unknown>() => undefined as T,
      }),
    } as ArgumentsHost;

    new ProblemDetailsFilter().catch(new Error(sensitive), host);

    expect(JSON.stringify(logger.mock.calls)).not.toContain(sensitive);
    expect(JSON.stringify(json.mock.calls)).not.toContain(sensitive);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, code: 'INTERNAL_ERROR' }),
    );
    logger.mockRestore();
  });
});
