# 3. Queue technology

## Status

Accepted

## Context

CLAUDE.md 24 requires an ADR for queue technology. Section 4 names Redis and
BullMQ in the stack, and 21.2 requires queue retry to be tested against a real
broker rather than a fake.

Two constraints shaped the decision. First, 3.6 requires every background job
to be idempotent, so the queue must support a caller-supplied job id rather
than generating its own. Second, the target machine had no container runtime
and no virtualisation, so "run Redis in Docker" was not available.

## Decision

BullMQ over a Redis-compatible server, behind a `JobQueue` interface in
`packages/event-bus`.

The interface matters more than the implementation. Two adapters satisfy it:
`BullMqQueue` for production, and `InlineQueue` which executes handlers in
process. Handlers never observe which one they are running under, so unit tests
need no broker and the production path is exercised separately by integration
tests.

`jobId` is a required field of the enqueue contract rather than an option.
BullMQ treats a duplicate job id as already queued, which is what makes retry
idempotent without a per-handler guard.

Locally the broker is Memurai, a Windows-native Redis-compatible server
reporting `redis_version: 7.2.5`. Two settings are mandatory:
`notify-keyspace-events` must include `Ex` or delayed jobs do not fire, and
`maxmemory-policy` must remain `noeviction` because BullMQ keeps job state in
Redis.

## Alternatives

- **PostgreSQL-backed queue (e.g. pg-boss).** Fewer moving parts, since
  PostgreSQL is already required. Rejected because 4 names BullMQ explicitly
  and because deployment targets Railway, where Redis is a first-class service.
- **In-process only.** Sufficient for the current job volume and needs no
  broker at all. Rejected because it cannot survive a restart, and losing a
  half-finished ingestion silently is exactly the failure mode this system
  exists to prevent.
- **Cloud-managed queue.** Rejected for local development: an offline
  workstation must be able to run the whole system.

## Consequences

Local development needs a Redis-compatible server. Memurai is API-compatible
rather than Redis itself, which is a small divergence from 21.2's "real Redis";
it is recorded here rather than hidden.

The `InlineQueue` adapter is production code, not test scaffolding, and must
stay behaviourally faithful. Its unit tests assert the same idempotency and
ordering guarantees as the BullMQ integration tests.

## Security implications

The broker holds job payloads. Payloads therefore carry identifiers rather than
content: no Pine source, no credentials, no protected holdout results. Section
19 forbids logging secrets, and a queue payload is effectively a log.

The broker binds to localhost in development and must not be exposed publicly.

## Migration/rollback

The `JobQueue` interface is the seam. Replacing BullMQ means writing one
adapter; no handler changes.
