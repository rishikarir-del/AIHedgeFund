/**
 * Object storage against real MinIO.
 *
 * CLAUDE.md 21.2 names "object ingestion" as a required integration test.
 * The organisation-isolation assertions matter most: 19 requires object paths
 * to be protected by organisation, and a prefix scheme is only protection if
 * it is actually enforced.
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  ObjectStore,
  deriveObjectKey,
  sha256,
  validateUpload,
  MAX_UPLOAD_BYTES,
} from '../src/object-store.js';
import { uuidv7 } from '../src/ids.js';

const ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const BUCKET = process.env.S3_BUCKET ?? 'arfos-artefacts';

const config = {
  endpoint: ENDPOINT,
  region: 'us-east-1',
  bucket: BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'arfos',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'arfos-local-dev',
  forcePathStyle: true,
};

let store: ObjectStore;
const orgA = uuidv7();
const orgB = uuidv7();

beforeAll(async () => {
  const admin = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch {
    // Already exists; fine.
  }
  admin.destroy();
  store = new ObjectStore(config);
});

afterAll(() => {
  store.destroy();
});

describe('key derivation (CLAUDE.md 19)', () => {
  it('scopes every key by organisation', () => {
    const checksum = sha256('x');
    expect(deriveObjectKey(orgA, 'pine_source', checksum)).toBe(
      `org/${orgA}/pine_source/${checksum}`,
    );
  });

  it('produces different keys for the same content in different organisations', () => {
    const checksum = sha256('identical content');
    expect(deriveObjectKey(orgA, 'pine_source', checksum)).not.toBe(
      deriveObjectKey(orgB, 'pine_source', checksum),
    );
  });

  it('refuses a non-UUID organisation, closing off path traversal', () => {
    expect(() => deriveObjectKey('../../etc', 'pine_source', sha256('x'))).toThrow(/UUID/);
  });

  it('refuses a checksum that is not a SHA-256 digest', () => {
    expect(() => deriveObjectKey(orgA, 'pine_source', 'short')).toThrow(/SHA-256/);
  });
});

describe('upload validation (CLAUDE.md 15.1)', () => {
  it('accepts a valid CSV export', () => {
    expect(
      validateUpload({ kind: 'tradingview_export', contentType: 'text/csv', sizeBytes: 1024 }),
    ).toEqual([]);
  });

  it('refuses a content type not allowed for the kind', () => {
    const problems = validateUpload({
      kind: 'tradingview_export',
      contentType: 'application/x-msdownload',
      sizeBytes: 1024,
    });
    expect(problems.map((p) => p.code)).toContain('content_type_not_allowed');
  });

  it('refuses an empty upload and an oversized one', () => {
    expect(
      validateUpload({ kind: 'pine_source', contentType: 'text/plain', sizeBytes: 0 }).map((p) => p.code),
    ).toContain('empty_upload');
    expect(
      validateUpload({
        kind: 'pine_source',
        contentType: 'text/plain',
        sizeBytes: MAX_UPLOAD_BYTES + 1,
      }).map((p) => p.code),
    ).toContain('upload_too_large');
  });
});

describe('round trip against MinIO', () => {
  const content = Buffer.from('//@version=6\nstrategy("Round trip")\n', 'utf8');
  const checksum = sha256(content);

  it('stores and reads back identical bytes', async () => {
    const key = deriveObjectKey(orgA, 'pine_source', checksum);
    await store.putObject(key, content, 'text/plain');

    expect(await store.objectExists(key)).toBe(true);
    expect((await store.getObject(key)).equals(content)).toBe(true);
  });

  it('verifies an upload against its declared checksum', async () => {
    const key = deriveObjectKey(orgA, 'pine_source', checksum);
    expect(await store.verifyUpload(key, checksum)).toBe(true);
  });

  it('rejects content that does not match the checksum in its key', async () => {
    const lyingKey = deriveObjectKey(orgA, 'pine_source', sha256('something else'));
    await store.putObject(lyingKey, content, 'text/plain');
    expect(await store.verifyUpload(lyingKey, sha256('something else'))).toBe(false);
  });

  it('reports a missing object as absent rather than throwing', async () => {
    const key = deriveObjectKey(orgB, 'pine_source', sha256('never uploaded'));
    expect(await store.objectExists(key)).toBe(false);
  });

  it('issues a presigned upload URL scoped to the derived key', async () => {
    const ticket = await store.createUploadTicket({
      organisationId: orgB,
      kind: 'tradingview_export',
      checksum: sha256('report'),
      contentType: 'text/csv',
    });

    expect(ticket.objectKey).toContain(`org/${orgB}/tradingview_export/`);
    expect(ticket.url).toContain('X-Amz-Signature');
    expect(ticket.expiresInSeconds).toBe(900);
  });
});
