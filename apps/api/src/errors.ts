/**
 * Typed domain errors and the problem-details response shape.
 *
 * CLAUDE.md 7.5 fixes the fields and forbids exposing secrets, model prompts,
 * SQL, stack traces or provider credentials to clients. `toProblemDetails`
 * is therefore the only path from an error to a response body, and it never
 * copies an unknown error's message through.
 */

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly traceId: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly validationErrors: readonly { readonly path: string; readonly message: string }[];

  constructor(init: {
    status: number;
    code: string;
    title: string;
    detail: string;
    validationErrors?: readonly { path: string; message: string }[];
  }) {
    super(init.detail);
    this.name = 'DomainError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.validationErrors = init.validationErrors ?? [];
  }
}

export const Errors = {
  unauthenticated: (detail = 'A valid bearer token is required.') =>
    new DomainError({ status: 401, code: 'unauthenticated', title: 'Unauthenticated', detail }),

  forbidden: (code: string, detail: string) =>
    new DomainError({ status: 403, code, title: 'Forbidden', detail }),

  notFound: (resource: string) =>
    new DomainError({
      status: 404,
      code: 'not_found',
      title: 'Not Found',
      // Deliberately identical whether the resource is absent or belongs to
      // another organisation: distinguishing them leaks existence.
      detail: `${resource} was not found.`,
    }),

  validation: (errors: readonly { path: string; message: string }[]) =>
    new DomainError({
      status: 422,
      code: 'validation_failed',
      title: 'Validation Failed',
      detail: 'The request body did not match the expected schema.',
      validationErrors: errors,
    }),

  idempotencyConflict: () =>
    new DomainError({
      status: 409,
      code: 'idempotency_key_reused',
      title: 'Conflict',
      detail: 'This Idempotency-Key was already used with a different request body.',
    }),

  policyRejected: (code: string, detail: string) =>
    new DomainError({ status: 409, code, title: 'Policy Rejected', detail }),
} as const;

export function toProblemDetails(
  error: unknown,
  instance: string,
  traceId: string,
): ProblemDetails {
  if (error instanceof DomainError) {
    return {
      type: `https://arf-os.local/problems/${error.code}`,
      title: error.title,
      status: error.status,
      detail: error.message,
      instance,
      code: error.code,
      traceId,
      ...(error.validationErrors.length > 0 ? { errors: error.validationErrors } : {}),
    };
  }

  // Unknown errors are never described to the client. The detail is fixed
  // text; the traceId is how an operator correlates it with the server log.
  return {
    type: 'https://arf-os.local/problems/internal_error',
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred. Quote the trace id when reporting it.',
    instance,
    code: 'internal_error',
    traceId,
  };
}
