/**
 * Campaigns, strategies and immutable versions.
 *
 * CLAUDE.md 3.1 is the governing rule here: a tested strategy version is never
 * mutated. Every material change creates a new `strategy_versions` row, and
 * lineage records the parent. None of these tables carries an `updated_at`,
 * because an update is not a legal operation on them.
 */
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../ids.js';
import { organisations, users } from './identity.js';

export const workflowStateEnum = pgEnum('workflow_state', [
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

export const agentRoleEnum = pgEnum('agent_role', [
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

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    brief: text('brief').notNull(),
    state: workflowStateEnum('state').notNull().default('CAMPAIGN_BACKLOG'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('campaigns_org_state_idx').on(t.organisationId, t.state)],
);

export const researchTasks = pgTable(
  'research_tasks',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    role: agentRoleEnum('role').notNull(),
    state: workflowStateEnum('state').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('research_tasks_campaign_idx').on(t.campaignId)],
);

export const strategies = pgTable(
  'strategies',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    family: text('family').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('strategies_org_idx').on(t.organisationId)],
);

/**
 * Immutable. Spec 3.2 and CLAUDE.md 3.1: any change to source, definition,
 * parameters, symbol, timeframe, session, costs, sizing, leverage, execution
 * settings, dataset, runner or segment assignment produces a new row here.
 */
export const strategyVersions = pgTable(
  'strategy_versions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    strategyId: uuid('strategy_id')
      .notNull()
      .references(() => strategies.id, { onDelete: 'restrict' }),
    versionNumber: integer('version_number').notNull(),
    state: workflowStateEnum('state').notNull().default('HYPOTHESIS_DRAFT'),
    /** Identity hashes that make a version reproducible (spec 3.5). */
    definitionHash: text('definition_hash').notNull(),
    sourceHash: text('source_hash'),
    manifestHash: text('manifest_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('strategy_versions_number_uq').on(t.strategyId, t.versionNumber),
    index('strategy_versions_state_idx').on(t.organisationId, t.state),
  ],
);

/** Parent/child edges, so a version's ancestry survives independently of numbering. */
export const strategyLineage = pgTable(
  'strategy_lineage',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    childVersionId: uuid('child_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'cascade' }),
    parentVersionId: uuid('parent_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('strategy_lineage_edge_uq').on(t.childVersionId, t.parentVersionId)],
);

/** The SDL document, validated against @arf/contracts before insert. */
export const strategyDefinitions = pgTable('strategy_definitions', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  strategyVersionId: uuid('strategy_version_id')
    .notNull()
    .unique()
    .references(() => strategyVersions.id, { onDelete: 'cascade' }),
  schemaVersion: text('schema_version').notNull(),
  document: jsonb('document').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pineRevisions = pgTable(
  'pine_revisions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'cascade' }),
    /** SHA-256 of the source. Uniqueness prevents storing the same source twice. */
    sourceHash: text('source_hash').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    /** Large source lives in object storage; this is the key (CLAUDE.md 9.1). */
    artefactKey: text('artefact_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('pine_revisions_version_hash_uq').on(t.strategyVersionId, t.sourceHash)],
);

/** Pointer records for immutable blobs held in object storage. */
export const artefacts = pgTable(
  'artefacts',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    objectKey: text('object_key').notNull(),
    checksum: text('checksum').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentType: text('content_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Deduplicate by content within an organisation; also makes upload
    // completion idempotent (CLAUDE.md 3.6).
    unique('artefacts_org_checksum_uq').on(t.organisationId, t.checksum),
  ],
);
