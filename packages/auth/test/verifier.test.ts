import { describe, expect, it } from 'vitest';
import { ClerkTokenVerifier, DevTokenVerifier } from '../src/verifier.js';

describe('DevTokenVerifier', () => {
  it('accepts a dev-prefixed token', async () => {
    await expect(new DevTokenVerifier().verify('dev:user_123')).resolves.toEqual({
      externalSubject: 'user_123',
    });
  });

  it('rejects anything else, so a real token never silently passes', async () => {
    const verifier = new DevTokenVerifier();
    await expect(verifier.verify('eyJhbGciOi...')).resolves.toBeNull();
    await expect(verifier.verify('dev:')).resolves.toBeNull();
    await expect(verifier.verify('')).resolves.toBeNull();
  });
});

describe('ClerkTokenVerifier', () => {
  it('requires a secret key at construction', () => {
    expect(
      () => new ClerkTokenVerifier({ secretKey: '', verifyToken: async () => null }),
    ).toThrow(/secret key/);
  });

  it('maps a verified subject', async () => {
    const verifier = new ClerkTokenVerifier({
      secretKey: 'sk_test',
      verifyToken: async () => ({ sub: 'user_abc' }),
    });
    await expect(verifier.verify('token')).resolves.toEqual({ externalSubject: 'user_abc' });
  });

  it('returns null rather than propagating provider errors (CLAUDE.md 7.5)', async () => {
    const verifier = new ClerkTokenVerifier({
      secretKey: 'sk_test',
      verifyToken: async () => {
        throw new Error('clerk exploded with secret sk_live_do_not_leak');
      },
    });
    await expect(verifier.verify('token')).resolves.toBeNull();
  });
});
