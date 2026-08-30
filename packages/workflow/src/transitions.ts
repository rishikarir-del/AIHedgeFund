/**
 * The transition table.
 *
 * CLAUDE.md 10 requires allowed transitions, required evidence, required role,
 * human-approval flags, hard-fail checks and a policy version to live in one
 * place: "never scatter transition checks across route handlers". This module
 * is that place, and it is pure data plus pure functions so it can be tested
 * without a database.
 */
import type { Capability } from '@arf/auth';

export const WORKFLOW_STATES = [
  'CAMPAIGN_BACKLOG',
  'IDEA_RESEARCH',
  'HYPOTHESIS_DRAFT',
  'PINE_DEVELOPMENT',
  'TRADINGVIEW_VERIFICATION',
  'PAPER_APPROVAL_REVIEW',
  'PAPER_APPROVED',
  'REJECTED',
  'BLOCKED',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Kinds of evidence a transition can demand. Each maps to a stored artefact. */
export const EVIDENCE_KINDS = [
  'idea_card',
  'indicator_card',
  'strategy_definition',
  'pine_revision',
  'backtest_run',
  'metric_snapshot',
  'parity_report',
  'validation_report',
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface TransitionRule {
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  readonly capability: Capability;
  readonly requiredEvidence: readonly EvidenceKind[];
  /** True when a named human must sign off; automation can never satisfy it. */
  readonly requiresHumanApproval: boolean;
}

/**
 * Terminal states. Nothing transitions out of them: CLAUDE.md 3.1 makes
 * versions immutable, so a rejected version is superseded by a new version
 * rather than revived.
 */
export const TERMINAL_STATES: readonly WorkflowState[] = ['PAPER_APPROVED', 'REJECTED'];

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    from: 'CAMPAIGN_BACKLOG',
    to: 'IDEA_RESEARCH',
    capability: 'campaign:create',
    requiredEvidence: [],
    requiresHumanApproval: false,
  },
  {
    from: 'IDEA_RESEARCH',
    to: 'HYPOTHESIS_DRAFT',
    capability: 'strategy:create',
    requiredEvidence: ['idea_card'],
    requiresHumanApproval: false,
  },
  {
    from: 'HYPOTHESIS_DRAFT',
    to: 'PINE_DEVELOPMENT',
    capability: 'strategy_version:create',
    requiredEvidence: ['strategy_definition'],
    requiresHumanApproval: false,
  },
  {
    from: 'PINE_DEVELOPMENT',
    to: 'TRADINGVIEW_VERIFICATION',
    capability: 'backtest:run',
    requiredEvidence: ['pine_revision', 'backtest_run'],
    requiresHumanApproval: false,
  },
  {
    from: 'TRADINGVIEW_VERIFICATION',
    to: 'PAPER_APPROVAL_REVIEW',
    capability: 'validation:run',
    requiredEvidence: ['parity_report', 'metric_snapshot'],
    requiresHumanApproval: false,
  },
  {
    // The only transition that grants approval, and the only one requiring a
    // human. Spec 25: "Human approval required before forward deployment".
    from: 'PAPER_APPROVAL_REVIEW',
    to: 'PAPER_APPROVED',
    capability: 'decision:make',
    requiredEvidence: ['parity_report', 'metric_snapshot', 'validation_report'],
    requiresHumanApproval: true,
  },
  {
    from: 'PAPER_APPROVAL_REVIEW',
    to: 'REJECTED',
    capability: 'decision:make',
    requiredEvidence: [],
    requiresHumanApproval: true,
  },
  {
    from: 'TRADINGVIEW_VERIFICATION',
    to: 'REJECTED',
    capability: 'validation:run',
    requiredEvidence: [],
    requiresHumanApproval: false,
  },
  {
    from: 'PINE_DEVELOPMENT',
    to: 'REJECTED',
    capability: 'strategy_version:create',
    requiredEvidence: [],
    requiresHumanApproval: false,
  },
];

/** Any non-terminal state may be blocked, and a blocked state may resume. */
export function isBlockTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (to === 'BLOCKED') return !TERMINAL_STATES.includes(from);
  return false;
}

export function findRule(from: WorkflowState, to: WorkflowState): TransitionRule | undefined {
  return TRANSITIONS.find((rule) => rule.from === from && rule.to === to);
}

/**
 * Policy version. Every decision record stores the version in force when it
 * was made, so a later change to this table cannot retroactively alter what a
 * past approval meant (CLAUDE.md 9.4 audit, spec 3.2 immutability).
 *
 * Bump this whenever TRANSITIONS or the hard-fail rules change.
 */
export const POLICY_VERSION = '1.0.0';
