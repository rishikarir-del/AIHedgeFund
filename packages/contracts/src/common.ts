/**
 * Shared primitives.
 *
 * CLAUDE.md 7.4 forbids binary floating point for authoritative monetary totals,
 * so money crosses every boundary as a decimal string and is only widened to a
 * decimal type at the edges. 7.3 requires UTC storage and ISO 8601 at API
 * boundaries. Percentages carry their semantics in the field name so that 0.05
 * and 5 can never be confused.
 */
import { z } from 'zod';

/** Decimal money as a string, e.g. "1988.64". Never a JS number. */
export const MoneySchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string, e.g. "1988.64"');
export type Money = z.infer<typeof MoneySchema>;

/** A percentage expressed 0-100, e.g. 19.89 means 19.89%. */
export const PercentSchema = z.number().finite();
export type Percent = z.infer<typeof PercentSchema>;

/** A ratio expressed 0-1, e.g. 0.1989. Distinct type from Percent by name. */
export const RatioSchema = z.number().finite();
export type Ratio = z.infer<typeof RatioSchema>;

export const IsoTimestampSchema = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** Semantic version of a contract shape. Every artefact carries one. */
export const SchemaVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

/** SHA-256 hex digest, used for Pine source, manifests and prompt versions. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

export const AgentRoleSchema = z.enum([
  'CHIEF_RESEARCH_ORCHESTRATOR',
  'IDEA_SCOUT',
  'INDICATOR_RESEARCHER',
  'STRATEGY_ARCHITECT',
  'PINE_ENGINEER',
  'BACKTEST_ENGINEER',
  'ROBUSTNESS_VALIDATOR',
  'FORWARD_TEST_OPERATOR',
  'STRATEGY_JUDGE',
  'DATA_INTEGRITY_ANALYST',
  'PORTFOLIO_RESEARCHER',
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** Spec 1.3. LIVE_APPROVED is deliberately present but grantable only by a human-authorised external process. */
export const ApprovalLevelSchema = z.enum([
  'RESEARCH_APPROVED',
  'PAPER_APPROVED',
  'LIVE_CANDIDATE',
  'LIVE_APPROVED',
  'REJECTED',
  'ARCHIVED',
]);
export type ApprovalLevel = z.infer<typeof ApprovalLevelSchema>;

/** Build-prompt workflow states for the first vertical slice. */
export const WorkflowStateSchema = z.enum([
  'CAMPAIGN_BACKLOG',
  'IDEA_RESEARCH',
  'HYPOTHESIS_DRAFT',
  'PINE_DEVELOPMENT',
  'TRADINGVIEW_VERIFICATION',
  'PAPER_APPROVAL_REVIEW',
  'PAPER_APPROVED',
  'REJECTED',
  'BLOCKED',
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

/**
 * Which body of data a number was computed over. Spec 14.5 and the UI rules in
 * 18.1 both forbid comparing metrics across incompatible scopes, so scope is a
 * required field rather than a convention.
 */
export const EvidenceScopeSchema = z.enum([
  'IN_SAMPLE',
  'VALIDATION',
  'OUT_OF_SAMPLE',
  'FINAL_HOLDOUT',
  'FORWARD',
]);
export type EvidenceScope = z.infer<typeof EvidenceScopeSchema>;
