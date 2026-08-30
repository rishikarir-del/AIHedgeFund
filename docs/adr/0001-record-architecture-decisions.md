# 1. Record architecture decisions

## Status

Accepted

## Context

CLAUDE.md section 24 requires an ADR for decisions covering workflow technology,
queue technology, analytical datastore, runner implementation, TradingView
automation, protected-data model, prompt-evaluation method, metric formula
changes, live-execution scope, and major security boundaries.

Section 2 also instructs any agent working in this repository to read the
relevant ADRs before implementing a feature, so the directory must exist and be
populated from the start rather than retrofitted.

## Decision

Architecture decisions are recorded as numbered Markdown files in `docs/adr/`,
using the structure mandated by CLAUDE.md section 24: Title, Status, Context,
Decision, Alternatives, Consequences, Security implications, Migration/rollback.

Where implementation and specification conflict, the conflict is made visible in
an ADR rather than resolved silently in code.

## Alternatives

- No ADRs, decisions captured in commit messages. Rejected: commit history is not
  discoverable by the reading path CLAUDE.md section 2 prescribes.
- A single running decisions document. Rejected: it does not support per-decision
  status transitions such as superseded.

## Consequences

Every decision in the section 24 list requires a file here before the
corresponding code merges. This adds friction deliberately.

## Security implications

None directly. ADRs must not contain secrets, credentials, or protected holdout
results.

## Migration/rollback

Not applicable.
