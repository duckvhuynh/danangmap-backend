import { identityEtag, requireIdentityVersion } from '../src/identity/identity-etag';

describe('identity ETag helpers', () => {
  const userId = '4ca5ce86-3f6a-4c5a-a0ce-f1ed15fc1f10';

  it('round-trips a strongly typed resource version', () => {
    const etag = identityEtag('user', userId, 17);

    expect(etag).toBe(`"user-${userId}-v17"`);
    expect(requireIdentityVersion(etag, 'user', userId)).toBe(17);
  });

  it('requires If-Match and rejects another resource identity', () => {
    expect(() => requireIdentityVersion(undefined, 'user', userId)).toThrow(
      expect.objectContaining({ code: 'ETAG_REQUIRED' }),
    );
    expect(() => requireIdentityVersion(`"invite-${userId}-v1"`, 'user', userId)).toThrow(
      expect.objectContaining({ code: 'ETAG_MISMATCH' }),
    );
  });

  it.each([
    `W/"user-${userId}-v1"`,
    `"user-${userId}-v0"`,
    `"user-${userId}-v1", "user-${userId}-v2"`,
    '*',
  ])('rejects unsupported or malformed validators: %s', (etag) => {
    expect(() => requireIdentityVersion(etag, 'user', userId)).toThrow(
      expect.objectContaining({ code: 'ETAG_MISMATCH' }),
    );
  });
});
