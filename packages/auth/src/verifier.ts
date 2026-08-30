/**
 * Token verification boundary.
 *
 * Clerk is the auth provider (CLAUDE.md 4), but the policy layer must not
 * depend on it: 7.1 asks for dependency injection at service boundaries, and
 * making authorisation testable without network access matters more than
 * saving an interface.
 *
 * A verifier answers one question -- which external subject is this? -- and
 * nothing more. Mapping a subject to an organisation and role is a database
 * read, deliberately not the provider's job, because 19 requires membership to
 * be proven locally rather than asserted by a token claim.
 */

export interface VerifiedSubject {
  readonly externalSubject: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedSubject | null>;
}

/**
 * Development and test verifier. Accepts `dev:<subject>` and nothing else.
 *
 * It is exported from the package root deliberately: the alternative is a
 * conditional inside the Clerk adapter, and a bypass that only exists in one
 * named class is easier to audit than a branch inside the real one. Wiring
 * this in production is a deployment error, not a code path.
 */
export class DevTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedSubject | null> {
    if (!token.startsWith('dev:')) return null;
    const subject = token.slice('dev:'.length).trim();
    return subject.length > 0 ? { externalSubject: subject } : null;
  }
}

export interface ClerkVerifierConfig {
  readonly secretKey: string;
  /** Injected so the adapter stays testable and 19's no-secret-logging rule is easy to honour. */
  readonly verifyToken: (token: string, secretKey: string) => Promise<{ sub: string } | null>;
}

/**
 * Thin adapter. Contains no research workflow logic, per 11.1's rule that
 * provider adapters stay free of domain concerns.
 */
export class ClerkTokenVerifier implements TokenVerifier {
  readonly #config: ClerkVerifierConfig;

  constructor(config: ClerkVerifierConfig) {
    if (!config.secretKey) {
      throw new Error('ClerkTokenVerifier requires a secret key');
    }
    this.#config = config;
  }

  async verify(token: string): Promise<VerifiedSubject | null> {
    try {
      const claims = await this.#config.verifyToken(token, this.#config.secretKey);
      return claims ? { externalSubject: claims.sub } : null;
    } catch {
      // Never surface provider errors to the caller: 7.5 forbids exposing
      // provider credentials or internals, and a failed verification is
      // indistinguishable from an invalid token by design.
      return null;
    }
  }
}
