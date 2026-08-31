/**
 * Endpoint redaction.
 *
 * ADR 0002 records that the engine authenticates with a key embedded in a URL
 * query string rather than a header, and that the key is a secret under
 * CLAUDE.md 19: it must not be logged, echoed in an error message, or included
 * in a problem-details response.
 *
 * A URL that carries a credential therefore cannot be interpolated into any
 * message without passing through here first. This is a separate module so the
 * rule has one testable home rather than being a habit.
 */

/** Query parameters whose values are secrets regardless of endpoint. */
const SECRET_PARAMS = ['key', 'apikey', 'api_key', 'token', 'access_token', 'secret'];

/**
 * Returns a form of the URL safe to log: origin and path preserved, every
 * secret-bearing parameter replaced. Falls back to a fixed string rather than
 * echoing input that failed to parse, since unparseable input may still
 * contain the credential.
 */
export function redactEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[unparseable endpoint]';
  }

  for (const [name] of [...url.searchParams]) {
    if (SECRET_PARAMS.includes(name.toLowerCase())) {
      url.searchParams.set(name, 'REDACTED');
    }
  }

  return url.toString();
}

/**
 * Scrubs any secret-looking token from arbitrary text before it reaches a log.
 * Applied to upstream error bodies, which are outside our control and have
 * been observed to echo the request URL back.
 */
export function redactText(text: string): string {
  return text
    .replace(/([?&](?:key|apikey|api_key|token|access_token|secret)=)[^&\s"']+/gi, '$1REDACTED')
    .replace(/\b(pk|sk)_[A-Za-z0-9_-]{8,}\b/g, '$1_REDACTED');
}
