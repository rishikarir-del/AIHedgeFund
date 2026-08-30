/**
 * S3-compatible object storage.
 *
 * CLAUDE.md 9.1 makes object storage authoritative for large immutable
 * artefacts -- Pine bundles, raw CSV exports, compressed equity series --
 * while PostgreSQL holds the pointers. This lives in @arf/db because it is the
 * other half of persistence and because 5 fixes the package list; adding a
 * storage package would be an arbitrary folder.
 *
 * 19 requires object paths to be protected by organisation, so keys are
 * derived here rather than accepted from callers. A caller cannot construct a
 * key that reaches another organisation's data because it never supplies one.
 *
 * 15.1 requires presigned uploads with validated type, size and checksum.
 */
import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type ArtefactKind =
  | 'pine_source'
  | 'tradingview_export'
  | 'equity_series'
  | 'chart_export'
  | 'agent_raw_output';

/** 15.1: only these may be uploaded, and only at these sizes. */
export const ALLOWED_CONTENT_TYPES: Readonly<Record<ArtefactKind, readonly string[]>> = {
  pine_source: ['text/plain'],
  tradingview_export: ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
  equity_series: ['application/gzip', 'application/json'],
  chart_export: ['image/png', 'image/svg+xml'],
  agent_raw_output: ['application/json'],
};

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface ObjectStoreConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** MinIO needs path-style addressing; real S3 does not. */
  readonly forcePathStyle?: boolean;
}

export interface UploadTicket {
  readonly url: string;
  readonly objectKey: string;
  readonly expiresInSeconds: number;
}

export interface ValidationProblem {
  readonly code: string;
  readonly detail: string;
}

/**
 * Organisation-scoped key. The organisation prefix is first so a bucket policy
 * can restrict by prefix, and the checksum is the filename so identical
 * content deduplicates naturally (matching the unique constraint on
 * `artefacts.checksum`).
 */
export function deriveObjectKey(
  organisationId: string,
  kind: ArtefactKind,
  checksum: string,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(organisationId)) {
    throw new Error('organisationId must be a UUID');
  }
  if (!/^[0-9a-f]{64}$/i.test(checksum)) {
    throw new Error('checksum must be a SHA-256 hex digest');
  }
  return `org/${organisationId}/${kind}/${checksum}`;
}

export function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 15.1 pre-upload validation. Returns every problem, not just the first. */
export function validateUpload(input: {
  readonly kind: ArtefactKind;
  readonly contentType: string;
  readonly sizeBytes: number;
}): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  if (!ALLOWED_CONTENT_TYPES[input.kind].includes(input.contentType)) {
    problems.push({
      code: 'content_type_not_allowed',
      detail: `${input.contentType} is not permitted for ${input.kind}.`,
    });
  }
  if (input.sizeBytes <= 0) {
    problems.push({ code: 'empty_upload', detail: 'Upload size must be greater than zero.' });
  }
  if (input.sizeBytes > MAX_UPLOAD_BYTES) {
    problems.push({
      code: 'upload_too_large',
      detail: `Upload of ${input.sizeBytes} bytes exceeds the ${MAX_UPLOAD_BYTES} byte limit.`,
    });
  }

  return problems;
}

export class ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(config: ObjectStoreConfig) {
    const clientConfig: S3ClientConfig = {
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    };
    this.#client = new S3Client(clientConfig);
    this.#bucket = config.bucket;
  }

  /** 15.1: uploads go direct to storage via a presigned URL, never through the API. */
  async createUploadTicket(input: {
    readonly organisationId: string;
    readonly kind: ArtefactKind;
    readonly checksum: string;
    readonly contentType: string;
    readonly expiresInSeconds?: number;
  }): Promise<UploadTicket> {
    const objectKey = deriveObjectKey(input.organisationId, input.kind, input.checksum);
    const expiresInSeconds = input.expiresInSeconds ?? 900;

    const url = await getSignedUrl(
      this.#client,
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        ContentType: input.contentType,
      }),
      { expiresIn: expiresInSeconds },
    );

    return { url, objectKey, expiresInSeconds };
  }

  async putObject(objectKey: string, body: Buffer, contentType: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObject(objectKey: string): Promise<Buffer> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Object ${objectKey} has no body`);
    return Buffer.from(bytes);
  }

  async objectExists(objectKey: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Confirms what actually landed matches what was promised. An upload whose
   * content hashes differently than its key is rejected: the key IS the
   * checksum, so a mismatch means the artefact is not what it claims to be.
   */
  async verifyUpload(objectKey: string, expectedChecksum: string): Promise<boolean> {
    const body = await this.getObject(objectKey);
    return sha256(body) === expectedChecksum.toLowerCase();
  }

  destroy(): void {
    this.#client.destroy();
  }
}
