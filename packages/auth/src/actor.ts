/**
 * Who is acting, and on whose behalf.
 *
 * An `Actor` is only ever constructed from a verified token plus a membership
 * row read from the database. CLAUDE.md 19 forbids trusting a client-supplied
 * organisation id, so `organisationId` here is the one proven by membership --
 * never one taken from a request body or query string.
 */

export const RBAC_ROLES = [
  'VIEWER',
  'RESEARCHER',
  'DEVELOPER',
  'VALIDATOR',
  'OPERATOR',
  'COMMITTEE_MEMBER',
  'ADMIN',
  'SERVICE_ACCOUNT',
] as const;

export type RbacRole = (typeof RBAC_ROLES)[number];

export interface Actor {
  readonly userId: string;
  /** Proven by a membership row, not supplied by the caller. */
  readonly organisationId: string;
  readonly role: RbacRole;
  /** Correlates every authorisation decision with its request (CLAUDE.md 20). */
  readonly traceId: string;
}

/**
 * A service account acting without a human. Kept distinct so audit records can
 * tell automated activity from a person, and so separation-of-duties rules can
 * refuse to let automation stand in for a required human approval.
 */
export function isAutomated(actor: Actor): boolean {
  return actor.role === 'SERVICE_ACCOUNT';
}
