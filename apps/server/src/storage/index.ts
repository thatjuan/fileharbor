import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { StorageConfig } from '../config.js';

/**
 * The narrow seam between File Harbor and any S3-compatible bucket
 * (AWS S3, Cloudflare R2, MinIO, Backblaze B2, ...).
 *
 * This module is the ONLY place in the codebase that imports the AWS SDK.
 * Every other module talks to storage through this interface, so swapping
 * provider, region, or path-style behaviour is a single-file change.
 *
 * Design notes:
 *
 * - All presign calls return a `{ url, expiresAt }` pair. The caller
 *   typically embeds `url` in a ticket and surfaces `expiresAt` to the
 *   client so it can decide whether to re-issue.
 * - `headObject` returns `null` for a missing object rather than throwing —
 *   "the object isn't there" is a successful, expected answer when verifying
 *   uploads landed. Genuine errors (5xx, network, auth) still throw.
 * - `headObject` returns normalized fields (`size`, `contentType`,
 *   `etag`, `lastModified`). The SDK shape (`ContentLength`, `ContentType`)
 *   does not leak across this boundary.
 * - `presignPut` signs `ContentType` and `ContentLength` only when the caller
 *   provides them. When signed, the uploader MUST send a matching
 *   `Content-Type` / `Content-Length` header on the actual PUT or S3 will
 *   reject with `SignatureDoesNotMatch`. This is a deliberate contract:
 *   `upload-tickets` (#5+) records what was promised, and signing those
 *   values turns a mismatched upload into a signature failure rather than
 *   a silently-wrong content type.
 */
export interface StorageProvider {
  /** Bucket name this provider is bound to. Exposed for diagnostics/logging. */
  readonly bucket: string;
  /** Default TTL applied when callers don't override `expiresInSeconds`. */
  readonly defaultTtlSeconds: number;

  presignPut(key: string, opts?: PresignPutOptions): Promise<PresignedUrl>;
  presignGet(key: string, opts?: PresignGetOptions): Promise<PresignedUrl>;
  presignDelete(key: string, opts?: PresignDeleteOptions): Promise<PresignedUrl>;

  /** Returns `null` when the object does not exist. Throws for other errors. */
  headObject(key: string): Promise<ObjectInfo | null>;

  deleteObject(key: string): Promise<void>;
}

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

export interface PresignPutOptions {
  /**
   * If set, baked into the signature. The uploader MUST send a matching
   * `Content-Type` header on the actual PUT.
   */
  contentType?: string;
  /**
   * If set, baked into the signature. The uploader MUST send a matching
   * `Content-Length` header on the actual PUT.
   */
  contentLength?: number;
  /** Override the provider default TTL for this single URL (seconds). */
  expiresInSeconds?: number;
}

export interface PresignGetOptions {
  /**
   * Sets `response-content-disposition` so the browser downloads with a
   * specific filename instead of the opaque S3 key.
   */
  responseContentDisposition?: string;
  /** Override the provider default TTL for this single URL (seconds). */
  expiresInSeconds?: number;
}

export interface PresignDeleteOptions {
  /** Override the provider default TTL for this single URL (seconds). */
  expiresInSeconds?: number;
}

export interface ObjectInfo {
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
}

/**
 * Build the storage provider from validated config. Construction is cheap —
 * no network I/O. Call `verifyStorage(provider)` separately at boot to
 * fail-fast on bad config.
 */
export function createStorageProvider(config: StorageConfig): StorageProvider {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });

  const bucket = config.bucket;
  const defaultTtlSeconds = config.presignTtlSeconds;

  function ttlFor(override: number | undefined): number {
    return override ?? defaultTtlSeconds;
  }

  async function signWithTtl(command: object, ttlSeconds: number): Promise<PresignedUrl> {
    // `getSignedUrl`'s command param is typed against the SDK's Command base;
    // it accepts any of the *ObjectCommand instances. We pass them through here.
    const url = await getSignedUrl(client, command as Parameters<typeof getSignedUrl>[1], {
      expiresIn: ttlSeconds,
    });
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    return { url, expiresAt };
  }

  return {
    bucket,
    defaultTtlSeconds,

    async presignPut(key, opts) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: opts?.contentType,
        ContentLength: opts?.contentLength,
      });
      return signWithTtl(command, ttlFor(opts?.expiresInSeconds));
    },

    async presignGet(key, opts) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: opts?.responseContentDisposition,
      });
      return signWithTtl(command, ttlFor(opts?.expiresInSeconds));
    },

    async presignDelete(key, opts) {
      const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
      return signWithTtl(command, ttlFor(opts?.expiresInSeconds));
    },

    async headObject(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          size: res.ContentLength ?? 0,
          contentType: res.ContentType ?? null,
          etag: res.ETag ?? null,
          lastModified: res.LastModified ?? null,
        };
      } catch (err: unknown) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

/**
 * Sanity check the configured bucket at boot. Performs a `HeadBucket` —
 * the canonical "does this bucket exist and am I authorized" probe.
 *
 * Why `HeadBucket`:
 *   - Needs only `s3:ListBucket` IAM, which any provider config already grants.
 *   - 200/403/404 are unambiguous: bucket OK / creds wrong / bucket missing.
 *   - No side effects (vs. seeding a sentinel object).
 *   - Works on AWS, R2, MinIO, B2.
 *
 * Throws with a clear, actionable error on failure so `main()` can exit
 * non-zero before the HTTP server starts listening.
 */
export async function verifyStorage(
  provider: StorageProvider,
  config: StorageConfig,
): Promise<void> {
  // We re-create a client here rather than expose the SDK client on the
  // provider — the verify step is a one-shot at boot and is the only other
  // legitimate SDK consumer in this module.
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: provider.bucket }));
  } catch (err: unknown) {
    const status = errorHttpStatus(err);
    const detail = errorMessage(err);
    if (status === 404) {
      throw new Error(
        `Storage bootstrap failed: bucket '${provider.bucket}' not found at ${config.endpoint}. ` +
          `Create the bucket or correct S3_BUCKET. (HeadBucket → 404)`,
      );
    }
    if (status === 403) {
      throw new Error(
        `Storage bootstrap failed: access denied to bucket '${provider.bucket}' at ${config.endpoint}. ` +
          `Check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY and bucket policy. (HeadBucket → 403)`,
      );
    }
    throw new Error(
      `Storage bootstrap failed: HeadBucket on '${provider.bucket}' at ${config.endpoint} ` +
        `failed (${status ?? 'no-status'}): ${detail}`,
    );
  } finally {
    client.destroy();
  }
}

function isNotFoundError(err: unknown): boolean {
  // The SDK throws `NotFound` for HeadObject 404, but the safest check is
  // the HTTP status on the response metadata — class identity / error name
  // varies across SDK versions and middleware paths.
  return errorHttpStatus(err) === 404;
}

function errorHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { $metadata?: { httpStatusCode?: number } };
  return e.$metadata?.httpStatusCode;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
