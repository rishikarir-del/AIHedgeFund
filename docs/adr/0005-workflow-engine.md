# 5. Workflow engine

## Status

Accepted

## Context

CLAUDE.md 24 requires an ADR for workflow technology. Section 10 specifies what
the engine must provide: allowed transitions, required evidence, required role,
human-approval requirement, hard-fail checks, a policy version, an idempotent
transition command and decision-record generation. It adds an instruction that
shapes everything: "never scatter transition checks across route handlers."

3.2 separately forbids workers changing lifecycle state, and 3.7 keeps
promotion gates in deterministic code rather than in prompts.

## Decision

A hand-written state machine in `packages/workflow`, pure and synchronous.

**The engine decides; the caller persists.** `transition()` reads no database
and writes nothing. It receives resolved facts, returns a typed result and an
audit draft, and the API applies both inside one transaction. Every rule is
therefore testable without infrastructure, and 19 of the 19 workflow tests run
with no database.

**Rejection is a value, not an exception.** Section 10 says the engine "does not
throw for expected policy rejection". A caller must handle `ok: false`
explicitly, which makes a forgotten check a type error.

**Idempotency is evaluated first.** A replayed transition returns success with
`idempotentReplay: true` rather than conflicting, so a client that lost a
response can safely retry.

**Every decision stamps `POLICY_VERSION`.** A later change to the transition
table cannot retroactively alter what a past approval meant.

**Hard-fail checks return every failure, not the first**, because 18.3 requires
the decision dialog to show all of them.

## Alternatives

- **A workflow framework (Temporal, XState, a BPMN engine).** Rejected on
  section 4's instruction to avoid a large framework where a small internal
  abstraction suffices, and on 26's prohibition on a framework that owns
  critical state implicitly. The state machine here is roughly 200 lines and
  fully inspectable.
- **Transition rules in the database.** Attractive for runtime editing.
  Rejected: it makes the rules invisible to code review and to type checking,
  and a promotion gate that can be edited without a deployment is a promotion
  gate that will be.
- **Rules expressed in agent prompts.** Rejected by 3.7 directly. A model
  recommendation is evidence, not authority.

## Consequences

Callers must resolve facts before asking, which is more work at the call site
and is the price of a pure engine. `gatherEvidence` and
`gatherPromotionFacts` in the decisions route do that resolution.

Changing the transition table requires bumping `POLICY_VERSION`, and old
decisions keep their original version.

The engine cannot enforce anything about data it is not given. Whether the
facts handed to it are accurate is the caller's responsibility, which is why
the ingestion pipeline computes evidence independently rather than trusting a
reported value.

## Security implications

Separation of duties is enforced through `packages/auth`, which the engine
calls rather than reimplements. A creator cannot approve their own version, and
automation cannot satisfy a human-approval requirement at all.

`LIVE_APPROVED` is unreachable from the engine. Section 1.3 places it outside
the system, and `authoriseLiveApproval` is unconditionally negative with a test
covering every role including ADMIN.

## Migration/rollback

The transition table is data. Adding a state or an edge is an additive change
plus a version bump. Removing one requires considering versions currently
sitting in that state, which is why terminal states cannot be transitioned out
of at all.
