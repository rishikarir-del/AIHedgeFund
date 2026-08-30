# 4. Object storage and the artefact boundary

## Status

Accepted

## Context

CLAUDE.md 9.1 makes object storage authoritative for large immutable artefacts
-- Pine bundles, raw CSV exports, compressed equity series -- while PostgreSQL
holds identity, workflow state and pointers. 15.1 requires presigned uploads
with validated type, size and checksum, and the raw upload preserved.

19 additionally requires object paths to be protected by organisation.

## Decision

S3-compatible storage via the AWS SDK, with the client living in
`packages/db`.

Placing it there is deliberate. Section 5 fixes the package list and adding a
`packages/storage` would be an arbitrary folder; `db` is already the
persistence package and owns the `artefacts` rows that point at these objects.

**Keys are derived, never accepted from callers.** `deriveObjectKey` composes
`org/{organisationId}/{kind}/{checksum}`. A caller cannot construct a key
reaching another organisation's data because it never supplies one. The
function refuses a non-UUID organisation id, which closes off path traversal,
and refuses anything that is not a SHA-256 digest.

**The key is the checksum.** Identical content deduplicates naturally, matching
the unique constraint on `artefacts(organisation_id, checksum)`, and
verification is a hash comparison rather than a stored-metadata lookup: content
that does not hash to its own key is not what it claims to be.

**Bytes never pass through the API.** It issues a presigned PUT; the client
uploads directly; completion verifies the stored object before an artefact row
exists.

## Alternatives

- **Store artefacts in PostgreSQL as bytea.** Simpler operationally. Rejected:
  9.1 assigns large immutable blobs to object storage, and CSV exports plus
  equity series would bloat the row store and every backup.
- **Upload through the API.** Simpler client. Rejected: it puts file bytes
  through the request path, requires request size limits tuned to the largest
  plausible export, and 15.1 specifies presigned uploads.
- **Client-supplied object keys.** Rejected outright: it makes cross-tenant
  access a matter of guessing a string.

## Consequences

Local development needs an S3-compatible server; MinIO covers this without a
container runtime.

Presigned URLs expire (15 minutes by default). A slow upload on a poor
connection can fail and must be retried, which is safe because completion is
idempotent through the artefact unique constraint.

Deletion is not implemented. Artefacts are immutable evidence, and 3.1 makes
tested versions immutable; a retention policy is future work requiring its own
ADR.

## Security implications

The organisation prefix is the tenant boundary and a bucket policy can enforce
it independently of application code.

Credentials are read from configuration and never logged: `describeConfig`
reports presence, not values, and a test asserts the summary cannot contain a
secret.

Uploads are validated for content type and size before a ticket is issued.
Malware scanning is not implemented and is noted as a gap for any deployment
accepting untrusted uploads.

## Migration/rollback

Any S3-compatible endpoint works via configuration. Moving providers is a
credential and endpoint change plus an object copy; keys are portable because
they are derived from data rather than provider semantics.
