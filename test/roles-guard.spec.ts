import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AppException } from '../src/common/http/app.exception';
import { RolesGuard } from '../src/identity/auth.guards';

function context(role?: string, mustChangePassword = false) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        principal: role
          ? { id: 'actor', role, sessionId: 'session', displayName: role, mustChangePassword }
          : undefined,
      }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('RolesGuard System Admin capabilities', () => {
  const reflector = {
    getAllAndOverride: jest.fn(() => ['editor']),
  } as unknown as Reflector;
  const guard = new RolesGuard(reflector);

  it('lets System Admin satisfy a content-role route while keeping normal deny-by-default', () => {
    expect(guard.canActivate(context('system_admin'))).toBe(true);
    expect(() => guard.canActivate(context('reviewer'))).toThrow(AppException);
    expect(() => guard.canActivate(context())).toThrow(AppException);
  });

  it('still enforces the forced password-change gate', () => {
    expect(() => guard.canActivate(context('system_admin', true))).toThrow(AppException);
  });
});
