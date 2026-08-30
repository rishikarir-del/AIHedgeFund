# Database overview

PostgreSQL 17. Schema in `packages/db/src/schema`, migrations in
`packages/db/migrations`. 23 tables in five groups.

## Conventions

**UUIDv7, generated in the application.** PostgreSQL gained a built-in
`uuidv7()` only in version 18. Generation lives in `packages/db/src/ids.ts` and
is tested for chronological ordering, which cursor pagination depends on, and
for absence of collisions within a single millisecond.

**Every money column is `numeric(20, 8)`.** Section 7.4 forbids binary floating
point for authoritative monetary totals. `packages/metrics` reads and writes
them as decimal strings and never converts to a JS number for arithmetic.

**Every timestamp is `timestamptz`.** There are zero `timestamp without time
zone` columns, verified directly against `information_schema`.

**Organisation-scoped tables carry a non-null `organisation_id`.** Section 19
requires ownership verified on every aggregate access, so the column is present
rather than reached through a join.

## Groups

### Identity
`organisations`, `users`, `memberships`

Auth is delegated to Clerk, so `users` holds a projection of an external
subject. There is no password column by design. `memberships` is unique on
`(organisation_id, user_id)`: separation of duties is meaningless if one person
can hold two conflicting roles at once.

### Research
`campaigns`, `research_tasks`, `strategies`, `strategy_versions`,
`strategy_lineage`, `strategy_definitions`, `pine_revisions`, `artefacts`

**No table here has an `updated_at`.** Section 3.1 makes a tested version
immutable, so an update is not a legal operation — the absence of the column is
the enforcement, not an oversight.

`strategy_versions` is unique on `(strategy_id, version_number)`.
`artefacts` is unique on `(organisation_id, checksum)`, which deduplicates
identical content and makes upload completion idempotent.

### Testing
`tradingview_verifications`, `report_uploads`, `backtest_runs`, `trades`,
`equity_points`, `drawdown_points`, `metric_snapshots`, `parity_reports`

`backtest_runs.reported_metrics` is what the source claimed.
`metric_snapshots.metrics` is what ARF calculated. They are separate tables so
that merging them requires deliberate effort, which section 26 forbids.

`metric_snapshots` is unique on `(run_id, scope, calculation_version)`, so
recomputing under the same version is a no-op and changing the version produces
a new row rather than overwriting history.

### Governance
`committee_decisions`, `audit_events`, `outbox_events`, `idempotency_records`

`audit_events` is append-only through the application: no update or delete path
exists. Each row carries actor, action, aggregate, prior and new state, reason
and trace id, as section 9.4 requires.

`idempotency_records` is unique on `(organisation_id, idempotency_key)` and
stores the request hash, so the same key with a different body is a conflict
rather than a second action.

## Referential behaviour

`onDelete: 'restrict'` is used deliberately where a parent should not vanish
under live research — deleting an organisation with campaigns is refused. A
test in `packages/db` initially failed on this and the teardown was fixed
rather than the constraint weakened.

## Transactions

Section 9.3 requires these to be atomic, and each is:

- state transition **plus** its audit event
- strategy-version creation **plus** lineage
- decision **plus** status change **plus** outbox event
- upload completion **plus** artefact row

## Migrations

Forward-only. An applied migration is never edited. `pnpm db:generate` reads
compiled output, so `pnpm build` must run first — see
[troubleshooting](./troubleshooting.md).
