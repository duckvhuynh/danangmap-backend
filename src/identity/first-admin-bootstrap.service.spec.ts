/* eslint-disable @typescript-eslint/unbound-method */
jest.mock('argon2', () => ({
  __esModule: true,
  default: { hash: jest.fn().mockResolvedValue('argon2id-password-hash') },
}));

import type { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { CryptoService } from '../common/crypto/crypto.service';
import { FirstAdminBootstrapService } from './first-admin-bootstrap.service';
import { AdminSessionEntity, UserEntity } from './identity.entities';
import type { IdentityRateLimitService } from './identity-rate-limit.service';

const configuredToken = 'A'.repeat(64);
const dto = {
  email: 'admin@example.gov.vn',
  username: 'system.admin',
  displayName: 'Quản trị hệ thống',
  password: 'Strong-Bootstrap-2026!',
  passwordConfirmation: 'Strong-Bootstrap-2026!',
};
const metadata = {
  requestId: '11111111-1111-4111-8111-111111111111',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

describe('FirstAdminBootstrapService', () => {
  function harness(token: string | undefined = configuredToken, mfaEnabled = false) {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ completed: false }])
        .mockResolvedValueOnce([]),
      save: jest.fn((entity: unknown, value: Record<string, unknown>) =>
        Promise.resolve({
          ...value,
          id:
            entity === UserEntity
              ? '22222222-2222-4222-8222-222222222222'
              : '33333333-3333-4333-8333-333333333333',
        }),
      ),
    } as unknown as EntityManager;
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ available: true }]),
      transaction: jest.fn((callback: (entityManager: EntityManager) => unknown) =>
        Promise.resolve(callback(manager)),
      ),
    } as unknown as DataSource;
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'app.initialAdminBootstrapToken') return token;
        if (key === 'app.mfaEnabled') return mfaEnabled;
        return undefined;
      }),
    } as unknown as ConfigService;
    const crypto = {
      randomToken: jest.fn().mockReturnValueOnce('preauth-token').mockReturnValueOnce('csrf-token'),
      digest: jest.fn((value: string) => `digest:${value}`),
    } as unknown as CryptoService;
    const audit = { append: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const rateLimits = {
      enforceBootstrapSystemAdmin: jest.fn().mockResolvedValue(undefined),
    } as unknown as IdentityRateLimitService;
    return {
      service: new FirstAdminBootstrapService(dataSource, config, crypto, audit, rateLimits),
      dataSource,
      manager,
      audit,
      rateLimits,
    };
  }

  it('reports unavailable without querying users when no operator token is configured', async () => {
    const { service, dataSource } = harness('');
    await expect(service.status()).resolves.toEqual({ available: false });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('reports availability from the users table without exposing configuration details', async () => {
    const { service, dataSource } = harness();
    await expect(service.status()).resolves.toEqual({ available: true });
    expect(dataSource.query).toHaveBeenCalledWith(
      'SELECT NOT EXISTS (SELECT 1 FROM users LIMIT 1) AS available',
    );
  });

  it('rate limits before token validation and records only a redacted failure reason', async () => {
    const { service, dataSource, audit, rateLimits } = harness();
    await expect(service.createSystemAdmin(dto, 'wrong-token', metadata)).rejects.toMatchObject({
      code: 'BOOTSTRAP_TOKEN_INVALID',
    });
    expect(rateLimits.enforceBootstrapSystemAdmin).toHaveBeenCalledWith(metadata.ip, 'wrong-token');
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.bootstrap_system_admin_failed',
        metadata: { outcome: 'failed', reason: 'invalid_token' },
      }),
    );
    expect(JSON.stringify((audit.append as jest.Mock).mock.calls)).not.toContain(dto.password);
    expect(JSON.stringify((audit.append as jest.Mock).mock.calls)).not.toContain('wrong-token');
  });

  it('creates the sole System Admin under an advisory lock and returns a pre-auth challenge when MFA is enabled', async () => {
    const { service, dataSource, manager, audit } = harness(configuredToken, true);
    await expect(service.createSystemAdmin(dto, configuredToken, metadata)).resolves.toEqual({
      sessionKind: 'preauth',
      token: 'preauth-token',
      csrfToken: 'csrf-token',
      data: {
        status: 'mfa_required',
        mfaEnrollmentRequired: true,
        challengeExpiresAt: expect.any(String),
      },
    });
    expect(dataSource.transaction).toHaveBeenCalledWith(expect.any(Function));
    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      ['danangmap:identity:first-system-admin-bootstrap:v1'],
    );
    expect(manager.save).toHaveBeenCalledWith(
      UserEntity,
      expect.objectContaining({ role: 'system_admin', mfaEnabled: false }),
    );
    expect(manager.save).toHaveBeenCalledWith(
      AdminSessionEntity,
      expect.objectContaining({ kind: 'preauth' }),
    );
    expect(audit.append).not.toHaveBeenCalled();
    const transactionalAudit = JSON.stringify((manager.query as jest.Mock).mock.calls[2]);
    expect(transactionalAudit).toContain('auth.bootstrap_system_admin_created');
    expect(transactionalAudit).not.toContain(dto.password);
    expect(transactionalAudit).not.toContain(configuredToken);
  });

  it('creates an authenticated session directly when MFA is disabled by default', async () => {
    const { service, manager } = harness();
    await expect(service.createSystemAdmin(dto, configuredToken, metadata)).resolves.toEqual({
      sessionKind: 'authenticated',
      token: 'preauth-token',
      csrfToken: 'csrf-token',
      data: {
        status: 'authenticated',
        mfaEnrollmentRequired: false,
        principal: expect.objectContaining({
          role: 'system_admin',
          mfaEnabled: false,
          mustChangePassword: false,
        }),
      },
    });
    expect(manager.save).toHaveBeenCalledWith(
      AdminSessionEntity,
      expect.objectContaining({ kind: 'authenticated' }),
    );
  });

  it('rejects a password containing the username before Argon2 or a transaction', async () => {
    const { service, dataSource, audit } = harness();
    const weak = {
      ...dto,
      password: 'System.Admin-2026!',
      passwordConfirmation: 'System.Admin-2026!',
    };
    await expect(service.createSystemAdmin(weak, configuredToken, metadata)).rejects.toEqual(
      expect.objectContaining({ code: 'BOOTSTRAP_PASSWORD_WEAK' }),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { outcome: 'failed', reason: 'weak_password' } }),
    );
  });
});
