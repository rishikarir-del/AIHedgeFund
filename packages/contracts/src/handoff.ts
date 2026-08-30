/**
 * Agent handoff envelope, spec section 8.
 *
 * CLAUDE.md 3.3 makes structured data canonical: prose may accompany a handoff
 * but never substitutes for a typed field, and the orchestrator rejects
 * unstructured output where an artefact is required (spec 8.1).
 */
import { z } from 'zod';
import { AgentRoleSchema, IsoTimestampSchema, SchemaVersionSchema, Sha256Schema } from './common.js';
import {
  ArtefactIdSchema,
  CampaignIdSchema,
  EvidenceIdSchema,
  HandoffIdSchema,
  ResearchTaskIdSchema,
  StrategyIdSchema,
  StrategyVersionIdSchema,
} from './ids.js';

export const HandoffStatusSchema = z.enum(['COMPLETE', 'PARTIAL', 'BLOCKED', 'FAILED']);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const RiskFlagSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['INFO', 'WARN', 'CRITICAL']),
  detail: z.string().min(1),
});
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

export const AgentIdentitySchema = z.object({
  role: AgentRoleSchema,
  agentId: z.string().min(1),
  /** Content hash of the prompt that produced this output (spec 11.2). */
  promptVersion: Sha256Schema,
});

export const HandoffSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  handoffId: HandoffIdSchema,
  campaignId: CampaignIdSchema,
  strategyId: StrategyIdSchema.nullable(),
  strategyVersionId: StrategyVersionIdSchema.nullable(),
  fromAgent: AgentIdentitySchema,
  toRole: AgentRoleSchema,
  taskId: ResearchTaskIdSchema,
  status: HandoffStatusSchema,
  /** Concise factual summary. Explanatory only; never the source of truth. */
  summary: z.string().min(1).max(2000),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
  riskFlags: z.array(RiskFlagSchema),
  artefactIds: z.array(ArtefactIdSchema),
  evidenceIds: z.array(EvidenceIdSchema),
  requestedAction: z.string().min(1),
  createdAt: IsoTimestampSchema,
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const HANDOFF_SCHEMA_VERSION = '1.0.0';

/**
 * The subset of spec 8.1 rejection rules that is decidable from the envelope
 * alone. Evidence-ID resolution, protected-information detection and
 * role-scope checks need repository access and live in packages/workflow.
 */
export function validateHandoffEnvelope(handoff: Handoff): RiskFlag[] {
  const problems: RiskFlag[] = [];

  if (handoff.status === 'COMPLETE' && handoff.artefactIds.length === 0) {
    problems.push({
      code: 'complete_without_artefact',
      severity: 'CRITICAL',
      detail: 'A COMPLETE handoff must attach at least one typed artefact (spec 8.1).',
    });
  }

  if (handoff.fromAgent.role === handoff.toRole) {
    problems.push({
      code: 'self_handoff',
      severity: 'CRITICAL',
      detail: 'An agent cannot hand off to its own role; separation of duties (spec 3.3).',
    });
  }

  if (handoff.strategyVersionId !== null && handoff.strategyId === null) {
    problems.push({
      code: 'version_without_strategy',
      severity: 'CRITICAL',
      detail: 'A strategy version cannot be referenced without its parent strategy.',
    });
  }

  return problems;
}
