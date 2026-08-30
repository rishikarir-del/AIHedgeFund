import { describe, expect, it } from 'vitest';
import type { Actor, RbacRole } from '../src/actor.js';
import { CAPABILITY_MATRIX, roleHasCapability } from '../src/capabilities.js';
import {
  authorise,
  authoriseDecision,
  authoriseHoldoutRead,
  authoriseLiveApproval,
  withinOrganisation,
} from '../src/policy.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function actor(role: RbacRole, overrides: Partial<Actor> = {}): Actor {
  return {
    userId: 'user-1',
    organisationId: ORG_A,
    role,
    traceId: 'trace-1',
    ...overrides,
  };
}

describe('organisation boundary (CLAUDE.md 19)', () => {
  it('refuses a resource in another organisation even for an admin', () => {
    const result = authorise({
      actor: actor('ADMIN'),
      capability: 'strategy:read',
      resourceOrganisationId: ORG_B,
    });
    expect(result).toMatchObject({ allowed: false, code: 'wrong_organisation' });
  });

  it('checks organisation before capability, so a denial does not reveal role gaps', () => {
    // VIEWER lacks org:manage AND is in the wrong org. The org denial must win,
    // otherwise the error tells a cross-tenant caller the resource exists.
    const result = authorise({
      actor: actor('VIEWER'),
      capability: 'org:manage',
      resourceOrganisationId: ORG_B,
    });
    expect(result).toMatchObject({ code: 'wrong_organisation' });
  });

  it('allows a matching organisation', () => {
    expect(withinOrganisation(actor('VIEWER'), ORG_A).allowed).toBe(true);
  });
});

describe('separation of duties (spec 17.2)', () => {
  it('a validator cannot edit Pine source', () => {
    expect(roleHasCapability('VALIDATOR', 'pine:write')).toBe(false);
  });

  it('a validator cannot create strategy versions', () => {
    expect(roleHasCapability('VALIDATOR', 'strategy_version:create')).toBe(false);
  });

  it('an operator cannot change the strategy definition', () => {
    expect(roleHasCapability('OPERATOR', 'strategy_version:create')).toBe(false);
    expect(roleHasCapability('OPERATOR', 'pine:write')).toBe(false);
  });

  it('a developer cannot make committee decisions', () => {
    expect(roleHasCapability('DEVELOPER', 'decision:make')).toBe(false);
  });

  it('no role can read the holdout without also being validator or committee', () => {
    const holders = (Object.keys(CAPABILITY_MATRIX) as RbacRole[]).filter((r) =>
      roleHasCapability(r, 'holdout:read'),
    );
    expect(holders.sort()).toEqual(['COMMITTEE_MEMBER', 'VALIDATOR']);
  });

  it('a service account can neither decide nor read the holdout (CLAUDE.md 3.7)', () => {
    expect(roleHasCapability('SERVICE_ACCOUNT', 'decision:make')).toBe(false);
    expect(roleHasCapability('SERVICE_ACCOUNT', 'holdout:read')).toBe(false);
    expect(roleHasCapability('SERVICE_ACCOUNT', 'prompt:promote')).toBe(false);
  });
});

describe('authoriseDecision', () => {
  const base = {
    capability: 'decision:make' as const,
    resourceOrganisationId: ORG_A,
    createdByUserId: 'someone-else',
  };

  it('allows a committee member deciding on work they did not create', () => {
    const result = authoriseDecision({ ...base, actor: actor('COMMITTEE_MEMBER') });
    expect(result.allowed).toBe(true);
    expect(result).toMatchObject({ requiresAudit: true });
  });

  it('refuses self-approval (spec 3.4)', () => {
    const result = authoriseDecision({
      ...base,
      actor: actor('COMMITTEE_MEMBER', { userId: 'author' }),
      createdByUserId: 'author',
    });
    expect(result).toMatchObject({ allowed: false, code: 'self_approval' });
  });

  it('refuses an override with no reason (spec 17.2)', () => {
    const result = authoriseDecision({
      ...base,
      actor: actor('COMMITTEE_MEMBER'),
      isOverride: true,
      overrideReason: '   ',
    });
    expect(result).toMatchObject({ allowed: false, code: 'override_without_reason' });
  });

  it('allows an override that states a reason', () => {
    const result = authoriseDecision({
      ...base,
      actor: actor('COMMITTEE_MEMBER'),
      isOverride: true,
      overrideReason: 'Validator flagged low trade count; accepted with documented caveat.',
    });
    expect(result.allowed).toBe(true);
  });

  it('refuses a service account outright', () => {
    const result = authoriseDecision({ ...base, actor: actor('SERVICE_ACCOUNT') });
    expect(result.allowed).toBe(false);
  });
});

describe('authoriseHoldoutRead (spec 3.5)', () => {
  const base = { resourceOrganisationId: ORG_A, validationComplete: true };

  it('allows ordinary scopes through the normal read capability', () => {
    const result = authoriseHoldoutRead({
      ...base,
      actor: actor('RESEARCHER'),
      stage: 'IN_SAMPLE',
      validationComplete: false,
    });
    expect(result.allowed).toBe(true);
    expect(result).toMatchObject({ requiresAudit: false });
  });

  it('refuses a researcher reading the final holdout', () => {
    const result = authoriseHoldoutRead({ ...base, actor: actor('RESEARCHER'), stage: 'FINAL_HOLDOUT' });
    expect(result).toMatchObject({ allowed: false, code: 'missing_capability' });
  });

  it('refuses even a validator before validation completes (CLAUDE.md 26: never tune on holdout)', () => {
    const result = authoriseHoldoutRead({
      ...base,
      actor: actor('VALIDATOR'),
      stage: 'FINAL_HOLDOUT',
      validationComplete: false,
    });
    expect(result).toMatchObject({ allowed: false, code: 'holdout_stage_not_reached' });
  });

  it('allows a validator afterwards, and demands an audit record', () => {
    const result = authoriseHoldoutRead({ ...base, actor: actor('VALIDATOR'), stage: 'FINAL_HOLDOUT' });
    expect(result).toEqual({ allowed: true, requiresAudit: true });
  });
});

describe('authoriseLiveApproval (spec 1.3)', () => {
  it('refuses every role including admin', () => {
    for (const role of Object.keys(CAPABILITY_MATRIX) as RbacRole[]) {
      const result = authoriseLiveApproval(actor(role));
      expect(result).toMatchObject({ allowed: false, code: 'live_approval_not_grantable' });
    }
  });
});
