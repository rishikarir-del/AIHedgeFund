/**
 * The capability matrix.
 *
 * Spec 17.2 lists the separation controls this encodes:
 *
 *   - Creators cannot approve their own versions.
 *   - Validators cannot edit source.
 *   - Operators cannot change strategy definition.
 *   - Committee overrides require a reason.
 *   - Prompt promotions require an authorised human.
 *   - Protected holdout access is role- and stage-scoped.
 *
 * Two of those are contextual rather than role-based (approving your own work,
 * and overrides needing a reason) and live in `policy.ts`. The rest are
 * expressible here as capabilities a role either has or does not.
 */
import type { RbacRole } from './actor.js';

export const CAPABILITIES = [
  'campaign:read',
  'campaign:create',
  'strategy:read',
  'strategy:create',
  'strategy_version:create',
  'pine:write',
  'backtest:run',
  'validation:run',
  'verification:upload',
  'decision:make',
  'forward:deploy',
  'forward:configure',
  'holdout:read',
  'prompt:promote',
  'org:manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const VIEWER: readonly Capability[] = ['campaign:read', 'strategy:read'];

const RESEARCHER: readonly Capability[] = [...VIEWER, 'campaign:create', 'strategy:create'];

const DEVELOPER: readonly Capability[] = [
  ...RESEARCHER,
  'strategy_version:create',
  'pine:write',
  'backtest:run',
  'verification:upload',
];

/**
 * Deliberately excludes `pine:write` and `strategy_version:create`: spec 17.2
 * says a validator cannot edit source. It gains `validation:run` and
 * `holdout:read`, the latter because spec 25 restricts final-holdout access to
 * the validator and backtest lanes.
 */
const VALIDATOR: readonly Capability[] = [...VIEWER, 'validation:run', 'backtest:run', 'holdout:read'];

/**
 * Runs forward deployments. Excludes every capability that would let it change
 * what is being tested, per spec 17.2 and 7.8's prohibition on changing
 * parameters during an active test.
 */
const OPERATOR: readonly Capability[] = [...VIEWER, 'forward:deploy', 'forward:configure'];

const COMMITTEE_MEMBER: readonly Capability[] = [...VIEWER, 'decision:make', 'holdout:read'];

const ADMIN: readonly Capability[] = [
  ...VIEWER,
  'campaign:create',
  'strategy:create',
  'decision:make',
  'prompt:promote',
  'org:manage',
];

/**
 * Automation may compute and record, never decide. It has no `decision:make`,
 * no `holdout:read`, and no `prompt:promote` -- CLAUDE.md 3.7 keeps authority
 * with humans and deterministic code, not with model-driven services.
 */
const SERVICE_ACCOUNT: readonly Capability[] = [
  'campaign:read',
  'strategy:read',
  'backtest:run',
  'strategy_version:create',
];

export const CAPABILITY_MATRIX: Readonly<Record<RbacRole, readonly Capability[]>> = {
  VIEWER,
  RESEARCHER,
  DEVELOPER,
  VALIDATOR,
  OPERATOR,
  COMMITTEE_MEMBER,
  ADMIN,
  SERVICE_ACCOUNT,
};

export function roleHasCapability(role: RbacRole, capability: Capability): boolean {
  return CAPABILITY_MATRIX[role].includes(capability);
}
