/**
 * The transition command.
 *
 * CLAUDE.md 10: the engine returns a typed success or failure result and does
 * not throw for expected policy rejection. It is also idempotent (3.6) --
 * re-issuing a transition that already happened returns the original outcome
 * rather than applying it twice or erroring.
 *
 * The engine decides. It does not persist. Callers apply the returned
 * `auditEvent` and `decisionRecord` inside the same transaction as the state
 * change (9.3), which keeps this module pure and testable.
 */
import { authorise, authoriseDecision, isAutomated, type Actor } from '@arf/auth';
import { checkPromotionHardFails, type HardFail, type PromotionFacts } from './hard-fails.js';
import {
  findRule,
  isBlockTransition,
  POLICY_VERSION,
  TERMINAL_STATES,
  type EvidenceKind,
  type WorkflowState,
} from './transitions.js';

export interface TransitionRequest {
  readonly actor: Actor;
  readonly aggregateId: string;
  readonly resourceOrganisationId: string;
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  /** Evidence actually attached to the version, resolved by the caller. */
  readonly presentEvidence: readonly EvidenceKind[];
  /** Who created the version under review, for the self-approval rule. */
  readonly createdByUserId: string;
  /** Only required when transitioning into PAPER_APPROVED. */
  readonly promotionFacts?: PromotionFacts | undefined;
  readonly reason?: string | undefined;
  /** Set when the caller has already applied this exact transition. */
  readonly alreadyInTargetState?: boolean | undefined;
}

export interface AuditEventDraft {
  readonly actor: string;
  readonly action: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly priorState: { readonly state: WorkflowState };
  readonly newState: { readonly state: WorkflowState };
  readonly reason: string | null;
  readonly traceId: string;
}

export type TransitionResult =
  | {
      readonly ok: true;
      readonly from: WorkflowState;
      readonly to: WorkflowState;
      readonly policyVersion: string;
      readonly auditEvent: AuditEventDraft;
      /** True when the transition had already been applied; no writes needed. */
      readonly idempotentReplay: boolean;
    }
  | {
      readonly ok: false;
      readonly code: TransitionFailureCode;
      readonly reason: string;
      readonly hardFails: readonly HardFail[];
    };

export type TransitionFailureCode =
  | 'not_allowed'
  | 'terminal_state'
  | 'unauthorised'
  | 'missing_evidence'
  | 'human_approval_required'
  | 'hard_fail'
  | 'missing_promotion_facts';

function fail(
  code: TransitionFailureCode,
  reason: string,
  hardFails: readonly HardFail[] = [],
): TransitionResult {
  return { ok: false, code, reason, hardFails };
}

export function transition(request: TransitionRequest): TransitionResult {
  const { actor, from, to } = request;

  // Idempotency first: a retry of an applied transition is a success, not a
  // conflict, so a client that lost a response can safely repeat it.
  if (request.alreadyInTargetState === true) {
    return {
      ok: true,
      from,
      to,
      policyVersion: POLICY_VERSION,
      idempotentReplay: true,
      auditEvent: buildAudit(request, 'workflow.transition.replay'),
    };
  }

  if (TERMINAL_STATES.includes(from)) {
    return fail(
      'terminal_state',
      `${from} is terminal; supersede the version with a new one rather than transitioning it.`,
    );
  }

  // Blocking is always available from a non-terminal state and needs no evidence.
  if (isBlockTransition(from, to)) {
    const scope = authorise({
      actor,
      capability: 'strategy:read',
      resourceOrganisationId: request.resourceOrganisationId,
    });
    if (!scope.allowed) return fail('unauthorised', scope.reason);
    return {
      ok: true,
      from,
      to,
      policyVersion: POLICY_VERSION,
      idempotentReplay: false,
      auditEvent: buildAudit(request, 'workflow.blocked'),
    };
  }

  const rule = findRule(from, to);
  if (!rule) {
    return fail('not_allowed', `No transition is defined from ${from} to ${to}.`);
  }

  const permitted = authorise({
    actor,
    capability: rule.capability,
    resourceOrganisationId: request.resourceOrganisationId,
  });
  if (!permitted.allowed) return fail('unauthorised', permitted.reason);

  const missing = rule.requiredEvidence.filter((kind) => !request.presentEvidence.includes(kind));
  if (missing.length > 0) {
    return fail('missing_evidence', `Missing required evidence: ${missing.join(', ')}.`);
  }

  if (rule.requiresHumanApproval) {
    if (isAutomated(actor)) {
      return fail('human_approval_required', 'This transition requires a named human approver.');
    }
    const decision = authoriseDecision({
      actor,
      capability: 'decision:make',
      resourceOrganisationId: request.resourceOrganisationId,
      createdByUserId: request.createdByUserId,
    });
    if (!decision.allowed) return fail('unauthorised', decision.reason);
  }

  if (to === 'PAPER_APPROVED') {
    if (!request.promotionFacts) {
      return fail(
        'missing_promotion_facts',
        'Promotion facts must be supplied to evaluate hard-fail checks.',
      );
    }
    const hardFails = checkPromotionHardFails(request.promotionFacts);
    if (hardFails.length > 0) {
      return fail('hard_fail', 'One or more hard-fail checks blocked promotion.', hardFails);
    }
  }

  return {
    ok: true,
    from,
    to,
    policyVersion: POLICY_VERSION,
    idempotentReplay: false,
    auditEvent: buildAudit(request, `workflow.${to.toLowerCase()}`),
  };
}

function buildAudit(request: TransitionRequest, action: string): AuditEventDraft {
  return {
    actor: request.actor.userId,
    action,
    aggregate: 'strategy_version',
    aggregateId: request.aggregateId,
    priorState: { state: request.from },
    newState: { state: request.to },
    reason: request.reason ?? null,
    traceId: request.actor.traceId,
  };
}
