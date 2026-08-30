import type { Actor, RbacRole } from '@arf/auth';
import { describe, expect, it } from 'vitest';
import { transition } from '../src/engine.js';
import type { PromotionFacts } from '../src/hard-fails.js';
import { POLICY_VERSION } from '../src/transitions.js';

const ORG = 'org-a';

function actor(role: RbacRole, userId = 'reviewer'): Actor {
  return { userId, organisationId: ORG, role, traceId: 'trace-1' };
}

const CLEAN_FACTS: PromotionFacts = {
  parityVerdict: 'PASS',
  evidenceSources: ['tradingview_csv', 'mcp_engine'],
  closedTradeCount: 204,
  maxDrawdownPct: 36,
  hasUnresolvedFailedRun: false,
  presentEvidence: [],
};

const APPROVAL_EVIDENCE = ['parity_report', 'metric_snapshot', 'validation_report'] as const;

function promote(overrides: Partial<Parameters<typeof transition>[0]> = {}) {
  return transition({
    actor: actor('COMMITTEE_MEMBER'),
    aggregateId: 'version-1',
    resourceOrganisationId: ORG,
    from: 'PAPER_APPROVAL_REVIEW',
    to: 'PAPER_APPROVED',
    presentEvidence: [...APPROVAL_EVIDENCE],
    createdByUserId: 'author',
    promotionFacts: CLEAN_FACTS,
    ...overrides,
  });
}

describe('transition basics', () => {
  it('allows a defined transition with the right role and evidence', () => {
    const result = transition({
      actor: actor('DEVELOPER'),
      aggregateId: 'v1',
      resourceOrganisationId: ORG,
      from: 'HYPOTHESIS_DRAFT',
      to: 'PINE_DEVELOPMENT',
      presentEvidence: ['strategy_definition'],
      createdByUserId: 'author',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.policyVersion).toBe(POLICY_VERSION);
  });

  it('refuses an undefined transition rather than inventing one', () => {
    const result = transition({
      actor: actor('ADMIN'),
      aggregateId: 'v1',
      resourceOrganisationId: ORG,
      from: 'CAMPAIGN_BACKLOG',
      to: 'PAPER_APPROVED',
      presentEvidence: [],
      createdByUserId: 'author',
    });
    expect(result).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  it('refuses to move out of a terminal state (CLAUDE.md 3.1)', () => {
    const result = transition({
      actor: actor('ADMIN'),
      aggregateId: 'v1',
      resourceOrganisationId: ORG,
      from: 'REJECTED',
      to: 'PINE_DEVELOPMENT',
      presentEvidence: [],
      createdByUserId: 'author',
    });
    expect(result).toMatchObject({ ok: false, code: 'terminal_state' });
  });

  it('names every missing evidence kind, not just the first', () => {
    const result = transition({
      actor: actor('DEVELOPER'),
      aggregateId: 'v1',
      resourceOrganisationId: ORG,
      from: 'PINE_DEVELOPMENT',
      to: 'TRADINGVIEW_VERIFICATION',
      presentEvidence: [],
      createdByUserId: 'author',
    });
    expect(result).toMatchObject({ ok: false, code: 'missing_evidence' });
    if (!result.ok) {
      expect(result.reason).toContain('pine_revision');
      expect(result.reason).toContain('backtest_run');
    }
  });

  it('refuses a cross-organisation transition', () => {
    const result = transition({
      actor: actor('DEVELOPER'),
      aggregateId: 'v1',
      resourceOrganisationId: 'other-org',
      from: 'HYPOTHESIS_DRAFT',
      to: 'PINE_DEVELOPMENT',
      presentEvidence: ['strategy_definition'],
      createdByUserId: 'author',
    });
    expect(result).toMatchObject({ ok: false, code: 'unauthorised' });
  });
});

describe('idempotency (CLAUDE.md 3.6)', () => {
  it('treats a replay as success without requiring writes', () => {
    const result = promote({ alreadyInTargetState: true, promotionFacts: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.idempotentReplay).toBe(true);
  });
});

describe('human approval (spec 25)', () => {
  it('refuses a service account on the approval transition', () => {
    const result = promote({ actor: actor('SERVICE_ACCOUNT', 'svc') });
    expect(result.ok).toBe(false);
  });

  it('refuses the version author approving their own work', () => {
    const result = promote({ actor: actor('COMMITTEE_MEMBER', 'author') });
    expect(result).toMatchObject({ ok: false, code: 'unauthorised' });
  });

  it('refuses a developer, who cannot decide', () => {
    const result = promote({ actor: actor('DEVELOPER') });
    expect(result).toMatchObject({ ok: false, code: 'unauthorised' });
  });

  it('allows a committee member who did not author it', () => {
    expect(promote().ok).toBe(true);
  });
});

describe('hard-fail checks on promotion', () => {
  it('blocks when parity failed (build prompt requirement)', () => {
    const result = promote({
      promotionFacts: { ...CLEAN_FACTS, parityVerdict: 'FAIL' },
    });
    expect(result).toMatchObject({ ok: false, code: 'hard_fail' });
    if (!result.ok) expect(result.hardFails.map((f) => f.code)).toContain('parity_failed');
  });

  it('blocks when parity is missing entirely', () => {
    const result = promote({ promotionFacts: { ...CLEAN_FACTS, parityVerdict: null } });
    if (!result.ok) expect(result.hardFails.map((f) => f.code)).toContain('parity_missing');
  });

  it('blocks engine-only evidence (ADR 0002)', () => {
    const result = promote({
      promotionFacts: { ...CLEAN_FACTS, evidenceSources: ['mcp_engine'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hardFails.map((f) => f.code)).toContain('no_tradingview_evidence');
  });

  it('blocks below the minimum trade count (spec 25)', () => {
    const result = promote({ promotionFacts: { ...CLEAN_FACTS, closedTradeCount: 40 } });
    if (!result.ok) expect(result.hardFails.map((f) => f.code)).toContain('insufficient_trades');
  });

  it('blocks a non-finite drawdown rather than treating it as a pass (CLAUDE.md 14)', () => {
    const result = promote({ promotionFacts: { ...CLEAN_FACTS, maxDrawdownPct: Number.NaN } });
    if (!result.ok) expect(result.hardFails.map((f) => f.code)).toContain('drawdown_unknown');
  });

  it('blocks when a failed run is unresolved (CLAUDE.md 26: never hide a failed backtest)', () => {
    const result = promote({ promotionFacts: { ...CLEAN_FACTS, hasUnresolvedFailedRun: true } });
    if (!result.ok) expect(result.hardFails.map((f) => f.code)).toContain('unresolved_failed_run');
  });

  it('reports every hard failure at once, not just the first (spec 18.3)', () => {
    const result = promote({
      promotionFacts: {
        parityVerdict: 'FAIL',
        evidenceSources: ['mcp_engine'],
        closedTradeCount: 3,
        maxDrawdownPct: Number.NaN,
        hasUnresolvedFailedRun: true,
        presentEvidence: [],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hardFails.length).toBe(5);
  });

  it('refuses promotion when facts were not supplied at all', () => {
    const result = promote({ promotionFacts: undefined });
    expect(result).toMatchObject({ ok: false, code: 'missing_promotion_facts' });
  });
});

describe('audit output (CLAUDE.md 9.4)', () => {
  it('carries actor, aggregate, both states and the trace id', () => {
    const result = promote({ reason: 'Evidence complete.' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.auditEvent).toMatchObject({
        actor: 'reviewer',
        aggregate: 'strategy_version',
        aggregateId: 'version-1',
        priorState: { state: 'PAPER_APPROVAL_REVIEW' },
        newState: { state: 'PAPER_APPROVED' },
        reason: 'Evidence complete.',
        traceId: 'trace-1',
      });
    }
  });
});
