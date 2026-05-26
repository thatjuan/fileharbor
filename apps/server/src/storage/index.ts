import type { StorageConfig } from '../config.js';
import { createLocalStorageProvider, verifyLocalStorage } from './local.js';
import { createS3StorageProvider, verifyS3Storage } from './s3.js';

/**
 * The narrow seam between File Harbor and storage. Two backends implement it:
 *
 *   - `s3`    — external S3-compatible bucket (AWS, R2, MinIO, B2, ...).
 *               Lives in `./s3.ts`; only that module imports the AWS SDK.
 *   - `local` — bytes on the same data volume as the SQLite DB. Lives in
 *               `./local.ts`; presigned URLs point at File Harbor's own
 *               routes (`/api/storage/o/...`) and are HMAC-signed.
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
 *   `etag`, `lastModified`). Provider-specific shapes do not leak across
 *   this boundary.
 * - `presignPut` signs `ContentType` and `ContentLength` only when the caller
 *   provides them. When signed, the uploader MUST send a matching
 *   `Content-Type` / `Content-Length` header on the actual PUT or the
 *   request is rejected. This is a deliberate contract: `upload-tickets`
 *   records what was promised, and signing those values turns a mismatched
 *   upload into a signature failure rather than a silently-wrong content type.
 *   Both backends honour this; S3 enforces it via SigV4, the local backend
 *   enforces it via header comparison against the signed canonical string.
 */
export interface StorageProvider {
  /**
   * Diagnostic label. In S3 mode this is the bucket name; in local mode it
   * is a `local:<path>` marker. Logged at boot and on errors.
   */
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
   * specific filename instead of the opaque storage key.
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
 * no network I/O. Call `verifyStorage(provider, config)` separately at boot
 * to fail-fast on bad config.
 */
export function createStorageProvider(config: StorageConfig): StorageProvider {
  if (config.backend === 'local') return createLocalStorageProvider(config);
  return createS3StorageProvider(config);
}

/**
 * Backend-aware boot probe. S3 mode runs `HeadBucket`; local mode runs a
 * write-and-unlink probe on `LOCAL_OBJECTS_DIR`. Either failure mode throws
 * with a clear, actionable error so `main()` exits non-zero before the HTTP
 * server starts listening.
 */
export async function verifyStorage(
  provider: StorageProvider,
  config: StorageConfig,
): Promise<void> {
  if (config.backend === 'local') return verifyLocalStorage(config);
  return verifyS3Storage(provider, config);
}
