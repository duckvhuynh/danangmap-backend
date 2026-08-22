import { createHash } from 'node:crypto';
import { resolveCrossStackExpiredInviteFixture } from './seed';

const token = 'expired-invite-token_0123456789abcdef';
const pepper = 'cross-stack-fixture-pepper-value-123456';
const allowedEnvironment: NodeJS.ProcessEnv = {
  ALLOW_SEED: 'true',
  SEED_CROSSSTACK_FIXTURES: 'true',
  SEED_CROSSSTACK_IDENTITY_FIXTURE: 'true',
  NODE_ENV: 'test',
  DANANGMAP_EXPIRED_INVITE_TOKEN: token,
  SESSION_PEPPER: pepper,
};

describe('cross-stack identity fixture', () => {
  it('persists only the production-compatible peppered digest', () => {
    expect(resolveCrossStackExpiredInviteFixture(allowedEnvironment)).toEqual({
      id: '70000000-0000-4000-8000-000000000001',
      tokenHash: createHash('sha256').update(`${token}:${pepper}`).digest('hex'),
    });
  });

  it.each([
    ['missing fixture opt-in', { SEED_CROSSSTACK_IDENTITY_FIXTURE: undefined }],
    ['production environment', { NODE_ENV: 'production' }],
    ['short token', { DANANGMAP_EXPIRED_INVITE_TOKEN: 'too-short' }],
    ['invalid token alphabet', { DANANGMAP_EXPIRED_INVITE_TOKEN: `${token}!` }],
    ['short pepper', { SESSION_PEPPER: 'too-short' }],
  ])('refuses %s without exposing the token', (_name, override) => {
    const candidate: NodeJS.ProcessEnv = { ...allowedEnvironment, ...override };
    let message = '';
    try {
      resolveCrossStackExpiredInviteFixture(candidate);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(candidate.DANANGMAP_EXPIRED_INVITE_TOKEN ?? token);
  });
});
