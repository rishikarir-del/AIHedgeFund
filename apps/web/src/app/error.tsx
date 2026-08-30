'use client';

/**
 * Error boundary.
 *
 * CLAUDE.md 7.5 forbids exposing stack traces to clients, so this shows the
 * message and, where the API supplied one, the trace id -- which is how an
 * operator correlates what the user saw with the server log. It never renders
 * `error.stack`.
 */
import type { ReactElement } from 'react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactElement {
  return (
    <div className="error-panel" role="alert">
      <h1>Something went wrong</h1>
      <p>{error.message}</p>
      {error.digest ? <p className="trace">Reference: {error.digest}</p> : null}
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
