# TradingView report parser

Lives in `packages/pine/src/tradingview-csv.ts`. Implements CLAUDE.md 15.2.

## The governing rule

> never guess an unknown column's meaning

The parser returns a discriminated failure rather than a best-effort parse. A
silently mis-mapped column produces numbers that look plausible and are wrong,
which is the worst available outcome for a system whose purpose is trustworthy
evidence. Refusing to parse is recoverable; quietly parsing wrong is not.

## Ambiguity handling

The important case is a lone comma followed by exactly three digits.

| Input | Result | Why |
|---|---|---|
| `18,964.26` | `18964.26` | Both separators present; the last is decimal |
| `18.964,26` | `18964.26` | Both present, European ordering |
| `1,5` | `1.5` | Cannot be a thousands separator |
| `1,234` | **refused** | `1234` in a US export, `1.234` in a European one |
| `(590.47)` | `-590.47` | Accounting negative |
| `—` | `0` | TradingView writes an em dash for empty cells |
| `n/a` | **refused** | Not a number |

`1,234` is unresolvable from the cell alone. Locale could be inferred from
elsewhere in the file, but a wrong inference is silent and a refusal is loud.

## Delimiter detection

Candidates are `,`, `;` and tab, counted in the header. If two appear equally
often the file is refused as ambiguous rather than resolved by preference
order.

## Column mapping

Versioned aliases map header cells to fields. `tradeNumber`, `type`,
`dateTime` and `price` are required; a missing one fails the parse. Unmapped
columns produce a warning naming them, so `Run-up` and `Drawdown` appearing in
an export are visible rather than silently dropped.

## Trade pairing

TradingView emits one row per fill: an entry row, then an exit row sharing the
same trade number. `pairTrades` in `apps/worker-backtest` joins them.

An entry with no matching exit becomes an **open trade** with a null profit,
not a discarded row. Section 14 forbids silently dropping a trade, and an open
position at the end of a backtest is a real result.

## Timestamps

Exports carry local times with no offset. They are treated as UTC, and that
assumption is written onto the run's `plan` rather than left implicit, so a
later comparison knows what was assumed. Section 7.3 forbids relying on the
server's local timezone.

## Fixtures

Test fixtures live beside their tests rather than in a shared directory, so a
change to a fixture cannot silently affect an unrelated test.

| Fixture | Location | Covers |
|---|---|---|
| Four-row US export | `packages/pine/test/tradingview-csv.test.ts` | Aliased columns, parenthesised loss, em dash |
| Semicolon European export | same | Comma decimals, alternate delimiter |
| Ragged row | same | Cell-count mismatch |
| Six-row paired ledger | `apps/worker-backtest/test/pipeline.integration.test.ts` | Full ingestion, three closed trades |

The integration fixture nets `433.62 - 124.75 + 210.00 = 518.87`, which the
pipeline must reproduce from the ledger without reading any reported total.

## Parity

`compareParity` follows section 15.3's order: source hash, manifest, symbol,
timeframe, date range, costs, sizing, execution mode, then trade sequence.

It reports the **first** divergence and stops. If source hashes differ, every
downstream metric difference is a consequence rather than a finding, and
listing them all would bury the one that matters.

A field absent on either side yields `INSUFFICIENT_DATA`, never `PASS`. Not
finding a disagreement is not the same as finding agreement.
