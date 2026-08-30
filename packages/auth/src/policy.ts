/**
 * Authorisation decisions.
 *
 * CLAUDE.md 10 establishes the shape: policy rejection is an expected outcome,
 * not an exception, so every function here returns a typed result and never
 * throws for a denial. Callers must handle `allowed: false` explicitly, which
 * makes a forgotten check a type error rather than a silent hole.
 *
 * Denials carry a stable `code` because 7.5 requires typed domain errors and
 * because audit records need something greppable.
 */
import type { Actor } from './actor.js';
import { isAutomated } from './actor.js';
import { roleHasCapability, type Capability } from './capabilities.js';

export type Decision =
  | { readonly allowed: true; readonly requiresAudit: boolean }
  | { readonly allowed: false; readonly code: DenialCode; readonly reason: string };

export type DenialCode =
  | 'wrong_organisation'
  | 'missing_capability'
  | 'self_approval'
  | 'override_without_reason'
  | 'holdout_stage_not_reached'
  | 'automation_cannot_decide'
  | 'live_approval_not_grantable';

function allow(requiresAudit = false): Decision {
  return { allowed: true, requiresAudit };
}

function deny(code: DenialCode, reason: string): Decision {
  return { allowed: false, code, reason };
}

/**
 * The organisation boundary. CLAUDE.md 19 requires ownership to be verified on
 * every aggregate access, so this is called before any capability check --
 * a caller with the right role in the wrong organisation is still refused.
 */
export function withinOrganisation(actor: Actor, resourceOrganisationId: string): Decision {
  if (actor.organisationId !== resourceOrganisationId) {
    return deny(
      'wrong_organisation',
      'Resource belongs to a different organisation than the actor membership proves.',
    );
  }
  return allow();
}

export interface AuthorisationRequest {
  readonly actor: Actor;
  readonly capability: Capability;
  readonly resourceOrganisationId: string;
}

/** Organisation boundary first, then capability. Order matters: it avoids leaking whether a resource exists. */
export function authorise(request: AuthorisationRequest): Decision {
  const scope = withinOrganisation(request.actor, request.resourceOrganisationId);
  if (!scope.allowed) return scope;

  if (!roleHasCapability(request.actor.role, request.capability)) {
    return deny(
      'missing_capability',
      `Role ${request.actor.role} does not hold capability ${request.capability}.`,
    );
  }

  return allow();
}

export interface DecisionRequest extends AuthorisationRequest {
  /** Who created the strategy version under review. */
  readonly createdByUserId: string;
  /** Spec 17.2: a committee override requires a stated reason. */
  readonly overrideReason?: string | undefined;
  readonly isOverride?: boolean | undefined;
}

/**
 * Spec 3.4 and 17.2: a creator cannot approve their own work, automation
 * cannot decide at all, and an override must state why.
 */
export function authoriseDecision(request: DecisionRequest): Decision {
  const base = authorise({
    actor: request.actor,
    capability: 'decision:make',
    resourceOrganisationId: request.resourceOrganisationId,
  });
  if (!base.allowed) return base;

  if (isAutomated(request.actor)) {
    return deny('automation_cannot_decide', 'A service account cannot record a committee decision.');
  }

  if (request.actor.userId === request.createdByUserId) {
    return deny(
      'self_approval',
      'The creator of a strategy version cannot decide on it (separation of duties).',
    );
  }

  if (request.isOverride === true && !request.overrideReason?.trim()) {
    return deny('override_without_reason', 'A committee override must record a reason.');
  }

  // Decisions are always audited, override or not.
  return allow(true);
}

export type EvidenceStage =
  | 'IN_SAMPLE'
  | 'VALIDATION'
  | 'OUT_OF_SAMPLE'
  | 'FINAL_HOLDOUT'
  | 'FORWARD';

export interface HoldoutReadRequest extends Omit<AuthorisationRequest, 'capability'> {
  readonly stage: EvidenceStage;
  /** True once robustness validation has completed for this version. */
  readonly validationComplete: boolean;
}

/**
 * Spec 3.5 and 17.2: final-holdout access is role- AND stage-scoped, and every
 * read is audited. Reading the holdout before validation completes is how a
 * strategy gets tuned on it, which 26 forbids outright.
 */
export function authoriseHoldoutRead(request: HoldoutReadRequest): Decision {
  const nonProtected: readonly EvidenceStage[] = ['IN_SAMPLE', 'VALIDATION', 'OUT_OF_SAMPLE'];
  if (nonProtected.includes(request.stage)) {
    return authorise({
      actor: request.actor,
      capability: 'strategy:read',
      resourceOrganisationId: request.resourceOrganisationId,
    });
  }

  const base = authorise({
    actor: request.actor,
    capability: 'holdout:read',
    resourceOrganisationId: request.resourceOrganisationId,
  });
  if (!base.allowed) return base;

  if (!request.validationComplete) {
    return deny(
      'holdout_stage_not_reached',
      'Final holdout cannot be read before robustness validation completes.',
    );
  }

  return allow(true);
}

/**
 * Spec 1.3 and CLAUDE.md 3.9: LIVE_APPROVED is grantable only by a
 * human-authorised external process. No role in this system can produce it, so
 * this function exists to be unconditionally negative and to give that refusal
 * a single, testable home.
 */
export function authoriseLiveApproval(_actor: Actor): Decision {
  return deny(
    'live_approval_not_grantable',
    'LIVE_APPROVED cannot be granted from within ARF-OS by any role (spec 1.3).',
  );
}
