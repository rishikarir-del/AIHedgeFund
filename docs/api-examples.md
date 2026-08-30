# API examples

Base URL `http://127.0.0.1:3001`. In development, authenticate with a seeded
dev token. Every example assumes `AUTH_DEV_MODE=true`.

## Conventions

- Errors are `application/problem+json` with `type`, `title`, `status`,
  `detail`, `instance`, `code` and `traceId` (section 7.5).
- Commands accept `Idempotency-Key`.
- Lists are cursor-paginated: `?limit=&after=`.
- A resource in another organisation returns **404, not 403** — a 403 would
  confirm it exists.

## Health

```bash
curl http://127.0.0.1:3001/health
```

## Create a campaign

```bash
curl -X POST http://127.0.0.1:3001/v1/campaigns -H "authorization: Bearer dev:dev-researcher" -H "content-type: application/json" -H "idempotency-key: campaign-001" -d "{\"name\":\"BTC trend\",\"brief\":\"Trend following on BTC perpetuals.\"}"
```

Repeating the identical request returns `200` with the original resource.
Repeating it with a **different** body returns `409 idempotency_key_reused`.

## List with pagination

```bash
curl "http://127.0.0.1:3001/v1/campaigns?limit=2" -H "authorization: Bearer dev:dev-researcher"
```

```json
{ "items": [ ... ], "nextCursor": "01a05..." }
```

## Create a strategy version

Requires `DEVELOPER`. The body must be a valid SDL document; it is validated
against `packages/contracts`, so `pyramiding: 3` is rejected with `422` and
field-level errors.

```bash
curl -X POST http://127.0.0.1:3001/v1/strategies/$STRATEGY/versions -H "authorization: Bearer dev:dev-developer" -H "content-type: application/json" -d @version.json
```

There is no `PATCH` or `PUT` on a version. Changing anything creates a child
version (section 3.1); `PATCH`, `PUT` and `DELETE` all return 404.

## Store a Pine revision

The linter runs before storage. A script containing
`barmerge.lookahead_on` or a negative history offset is refused:

```json
{ "code": "pine_lint_failed", "status": 409,
  "detail": "Static checks failed: lookahead_on." }
```

## Verification and upload

```bash
curl -X POST http://127.0.0.1:3001/v1/tradingview-verifications/$ID/upload-ticket -H "authorization: Bearer dev:dev-developer" -H "content-type: application/json" -d "{\"reportType\":\"list_of_trades\",\"checksum\":\"$SHA256\",\"contentType\":\"text/csv\",\"sizeBytes\":1024}"
```

Returns a presigned `url` and the derived `objectKey`. The client `PUT`s the
file to that URL directly, then calls completion, which verifies the stored
bytes hash to the declared checksum before an artefact row is created.

## Protected evidence

Final-holdout metrics are role **and** stage scoped, and the read is audited:

```bash
curl "http://127.0.0.1:3001/v1/backtest-runs/$RUN/metrics?stage=FINAL_HOLDOUT" -H "authorization: Bearer dev:dev-committee"
```

A researcher gets `403 missing_capability`. A validator before validation
completes gets `403 holdout_stage_not_reached` — reading the holdout early is
how a strategy gets tuned on it.

## Record a decision

```bash
curl -X POST http://127.0.0.1:3001/v1/decisions -H "authorization: Bearer dev:dev-committee" -H "content-type: application/json" -H "idempotency-key: decision-001" -d "{\"strategyVersionId\":\"$VERSION\",\"to\":\"PAPER_APPROVED\",\"rationale\":\"Evidence complete and parity passed.\"}"
```

When the workflow engine refuses, the problem body carries **every** hard
failure so the decision UI can show them all (section 18.3):

```json
{ "code": "hard_fail", "status": 409,
  "hardFails": [
    { "code": "parity_failed", "detail": "Parity comparison failed..." },
    { "code": "no_tradingview_evidence", "detail": "Promotion requires a TradingView-sourced run..." }
  ] }
```

No role can produce `LIVE_APPROVED`. That is not an endpoint gap — section 1.3
places it outside the system entirely.

## Audit timeline

```bash
curl http://127.0.0.1:3001/v1/versions/$VERSION/audit -H "authorization: Bearer dev:dev-developer"
```

Append-only. Entries are never edited or removed.
