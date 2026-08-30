/**
 * Branded domain identifiers.
 *
 * CLAUDE.md 7.2 requires UUIDv7-compatible IDs represented as branded strings so
 * that a StrategyId cannot be passed where a StrategyVersionId is expected. The
 * brand exists only in the type system; at runtime these are plain strings.
 */
import { z } from 'zod';

/**
 * The brand is a phantom string-literal property, exactly as CLAUDE.md 7.2
 * specifies. A `unique symbol` brand would be stronger but cannot be named in
 * declaration output, which breaks `composite` builds across workspace packages.
 */
type Branded<T extends string> = string & { readonly __brand: T };

export type CampaignId = Branded<'CampaignId'>;
export type ResearchTaskId = Branded<'ResearchTaskId'>;
export type StrategyId = Branded<'StrategyId'>;
export type StrategyVersionId = Branded<'StrategyVersionId'>;
export type PineRevisionId = Branded<'PineRevisionId'>;
export type BacktestRunId = Branded<'BacktestRunId'>;
export type MetricSnapshotId = Branded<'MetricSnapshotId'>;
export type EvidenceId = Branded<'EvidenceId'>;
export type ArtefactId = Branded<'ArtefactId'>;
export type HandoffId = Branded<'HandoffId'>;
export type AgentRunId = Branded<'AgentRunId'>;
export type DecisionId = Branded<'DecisionId'>;
export type ForwardDeploymentId = Branded<'ForwardDeploymentId'>;
export type OrganisationId = Branded<'OrganisationId'>;
export type ActorId = Branded<'ActorId'>;

/**
 * UUIDv7 is a UUID with version nibble 7. Validating the version rather than
 * accepting any UUID keeps time-ordering guarantees that downstream cursor
 * pagination depends on.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuidV7 = z.string().regex(UUID_V7, 'must be a UUIDv7');

/** Build a Zod schema that parses into a specific branded ID type. */
function idSchema<T extends string>(): z.ZodType<Branded<T>> {
  return uuidV7.transform((value) => value as Branded<T>);
}

export const CampaignIdSchema = idSchema<'CampaignId'>();
export const ResearchTaskIdSchema = idSchema<'ResearchTaskId'>();
export const StrategyIdSchema = idSchema<'StrategyId'>();
export const StrategyVersionIdSchema = idSchema<'StrategyVersionId'>();
export const PineRevisionIdSchema = idSchema<'PineRevisionId'>();
export const BacktestRunIdSchema = idSchema<'BacktestRunId'>();
export const MetricSnapshotIdSchema = idSchema<'MetricSnapshotId'>();
export const EvidenceIdSchema = idSchema<'EvidenceId'>();
export const ArtefactIdSchema = idSchema<'ArtefactId'>();
export const HandoffIdSchema = idSchema<'HandoffId'>();
export const AgentRunIdSchema = idSchema<'AgentRunId'>();
export const DecisionIdSchema = idSchema<'DecisionId'>();
export const ForwardDeploymentIdSchema = idSchema<'ForwardDeploymentId'>();
export const OrganisationIdSchema = idSchema<'OrganisationId'>();
export const ActorIdSchema = idSchema<'ActorId'>();

export const UuidV7Schema = uuidV7;
