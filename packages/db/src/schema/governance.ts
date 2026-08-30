/**
 * Decisions, audit, outbox and idempotency.
 *
 * CLAUDE.md 9.4 requires audit tables to be append-only through the
 * application, 9.3 requires a transactional outbox for reliable event
 * emission, and 3.6 requires every side-effecting command to be idempotent.
 */
import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../ids.js';
import { organisations, users } from './identity.js';
import { strategyVersions } from './research.js';

export const decisionOutcomeEnum = pgEnum('decision_outcome', [
  'REJECT',
  'REWORK_WITH_NEW_VERSION',
  'PAPER_APPROVED',
]);

export const committeeDecisions = pgTable(
  'committee_decisions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'restrict' }),
    outcome: decisionOutcomeEnum('outcome').notNull(),
    /** Spec 18.3 requires the strongest rejection case to be recorded, not just the verdict. */
    rationale: text('rationale').notNull(),
    rejectionCase: text('rejection_case'),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    policyVersion: text('policy_version').notNull(),
    evidenceIds: jsonb('evidence_ids').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('committee_decisions_version_idx').on(t.strategyVersionId)],
);

/**
 * Append-only. No update or delete path exists in the application layer.
 * Every protected-data read also writes a row here (CLAUDE.md 3.5).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    aggregate: text('aggregate').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    priorState: jsonb('prior_state'),
    newState: jsonb('new_state'),
    reason: text('reason'),
    traceId: text('trace_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_aggregate_idx').on(t.aggregate, t.aggregateId),
    index('audit_events_org_time_idx').on(t.organisationId, t.createdAt),
  ],
);

/**
 * Transactional outbox. A domain event is written in the same transaction as
 * the state change, then published separately, so a crash between the two
 * cannot lose the event (CLAUDE.md 9.3).
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [index('outbox_unpublished_idx').on(t.publishedAt, t.createdAt)],
);

/**
 * Spec 17.5: persist the key, actor and request hash. Reusing a key with a
 * different body is a conflict, which is why the hash is stored rather than
 * just the key.
 */
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    actor: text('actor').notNull(),
    requestHash: text('request_hash').notNull(),
    responseReference: text('response_reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('idempotency_org_key_uq').on(t.organisationId, t.idempotencyKey)],
);
