# 2. Backtest result source: TradingView CSV export versus structured MCP engine

## Status

Accepted

## Context

The specification and the build prompt both assume backtest evidence arrives as
TradingView CSV exports uploaded by a human:

- CLAUDE.md section 15 defines report ingestion entirely in terms of CSV parsing,
  delimiter and locale detection, and versioned column adapters.
- CLAUDE.md section 3.8 forbids browser automation as a core dependency, which is
  the reason manual export exists: TradingView offers no batch API for Strategy
  Tester runs.
- Spec section 13.2 makes human-assisted verification the MVP workflow.
- The build prompt's vertical slice is items 6 through 10: create a verification
  task, upload two CSVs, parse them, reconstruct the ledger, compute metrics
  independently, and produce a parity report.

Since those documents were written, a structured backtest engine has become
available to this project (trader.dev, reached over MCP). It returns trades,
equity, and metrics as JSON in roughly three seconds, requires no browser and no
manual export, and self-reports a TradingView parity profile plus an engine
version identifier.

This is a genuine conflict. Building section 15 as specified means constructing a
CSV upload, parsing, and locale-detection pipeline to obtain data the engine
already returns in structured form.

Confirmed independently: an engine run of a plain EMA crossover on
BYBIT:BTCUSDT.P returned internally consistent figures across every field except
`maxRunup`, which was reported as zero on a demonstrably profitable run. That
single defect is itself an argument for keeping independent recalculation
regardless of which source is chosen.

## Decision

**The MCP engine is the scale path. TradingView remains the acceptance and
parity environment. Neither is the sole source of truth.**

This is not a new position. CLAUDE.md section 1 already states that "a
Pine-compatible local runner may be used for scale, but TradingView is the final
acceptance and parity environment for Pine behaviour." The MCP engine is such a
runner, reached over a network rather than in-process. This ADR applies the
existing rule to it rather than inventing a policy.

Consequences for implementation:

1. `BacktestRunResult` carries a `source` discriminator (`tradingview_csv` |
   `mcp_engine` | `local_runner`) with per-source identity fields. Every run
   records where its numbers came from. Already implemented in
   `packages/contracts`.
2. Research iteration, parameter sweeps, and robustness testing use
   `mcp_engine`. This is the volume path.
3. No strategy version reaches `PAPER_APPROVED` on engine evidence alone. The
   promotion gate requires a `tradingview_csv` run and a parity report that is
   not `FAIL`, preserving section 13.2 and section 26's rule against merging
   runner and TradingView results without a parity report.
4. Independent recalculation applies to every source without exception. Reported
   metrics are never trusted, never merged into calculated metrics, and the
   `maxRunup` defect above is the standing example of why.
5. CSV ingestion (CLAUDE.md section 15) is still built, but at milestone 7 it
   serves acceptance rather than every run, which lowers its throughput
   requirements considerably.

## Alternatives

- **Build CSV ingestion as specified, ignore the engine.** Rejected: substantial
  work to reach a state the engine already provides, and it makes a manual human
  step mandatory for every single research iteration, which caps throughput at
  human speed and contradicts spec section 2.1 goal 10 (scale to many concurrent
  campaigns).
- **Adopt the MCP engine and delete section 15.** Rejected: it would make an
  external service the sole source of truth with nothing checking it, which
  contradicts section 14 and section 26. The `maxRunup` defect demonstrates the
  failure mode concretely.

## Consequences

Milestones 1 through 6 are unaffected. Milestone 7 is unblocked and its scope
narrows: the upload path serves acceptance runs, not bulk ingestion.

A parity tolerance policy is now required and does not yet exist. Spec section
13.4 names parity tolerances but does not set numbers for engine-to-TradingView
comparison. That is a follow-up ADR, blocking milestone 14, not milestone 7.

Spec section 13 and CLAUDE.md section 15 should be amended to describe the two
paths rather than assuming one. They are not deleted.

CLAUDE.md section 12.4's golden Pine fixtures become the mechanism for
establishing engine-to-TradingView parity, which is a use they were already
designed for.

## Security implications

The engine path sends Pine strategy source to a third-party service and
authenticates with a key embedded in a URL query string rather than a header.
That is a wider trust boundary than CSV upload, where data only moves from
TradingView to local storage.

Constraints, binding:

- Strategy source and parameters may leave the system on this path. Nothing else
  may. No credentials, no protected holdout dates, no organisation identifiers.
- The engine key is a secret under CLAUDE.md section 19 and must not be logged,
  echoed in error messages, or included in a problem-details response.
- Engine results are untrusted input. They are validated against
  `BacktestRunResultSchema` before storage, per section 3.3.
- This decision does not authorise sending TradingView CSV exports to any
  external service; the build prompt's prohibition on sending exports to a model
  is unaffected.

## Migration/rollback

Low cost. Because `source` is a discriminated union rather than an assumption
baked into the schema, adding or removing a source is an additive contract
change. Runs recorded under one source remain valid and readable if the policy
changes.

To roll back to CSV-only, remove `mcp_engine` from the enum and the promotion
gate is already satisfied, since it requires TradingView evidence regardless.
