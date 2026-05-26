import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3StorageConfig } from '../config.js';
import type { PresignedUrl, StorageProvider } from './index.js';

/**
 * S3-compatible storage backend. This module is the ONLY place in the
 * codebase that imports the AWS SDK; every other module talks to storage
 * through the `StorageProvider` interface, so swapping provider, region, or
 * path-style behaviour is a single-file change.
 */
export function createS3StorageProvider(config: S3StorageConfig): StorageProvider {
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

  /**
   * In-memory cache of open multipart sessions keyed by `uploadId`. Lets
   * `presignUploadPart` and `completeMultipart` read the resolved `partSize`
   * (and the original `sizeHint`/`contentType`) without an extra round-trip
   * to S3. The cache is process-local and lost on restart; on a multi-process
   * deployment the same uploadId is only ever consumed by the originating
   * process within the URL TTL window. The durable `upload_tickets` row
   * carries the same `part_size`/`expected_parts` the caller passes back in,
   * so a cache miss is recoverable (just slower) — the storage layer itself
   * never reads it back.
   */
  const sessions = new Map<
    string,
    { partSize: number; sizeHint: number; contentType: string }
  >();

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

    async initMultipart(key, opts) {
      // Resolve the effective part size: never below caller's configured
      // floor, and large enough to keep the part count <= 10_000 (S3's hard
      // cap). For files smaller than configuredFloor * 10_000 this is just
      // configuredFloor; for very large files it scales linearly.
      const partSize = Math.max(
        opts.partSizeBytes,
        Math.ceil(opts.sizeHint / 10_000),
      );
      const expectedParts = Math.ceil(opts.sizeHint / partSize);

      const res = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: opts.contentType,
        }),
      );
      const uploadId = res.UploadId;
      if (!uploadId) {
        throw new Error(
          `S3 CreateMultipartUpload returned no UploadId for key=${JSON.stringify(key)}`,
        );
      }
      sessions.set(uploadId, {
        partSize,
        sizeHint: opts.sizeHint,
        contentType: opts.contentType,
      });
      return { uploadId, partSize, expectedParts };
    },

    async presignUploadPart(key, uploadId, partNumber, opts) {
      // R3: deliberately DO NOT include ContentType on the UploadPart
      // presign. The single-PUT path does, but UploadPart's SigV4 does not
      // need (or want) it; signing it would make the rejection mode opaque
      // when intermediaries strip the header.
      const command = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      return signWithTtl(command, ttlFor(opts?.expiresInSeconds));
    },

    async completeMultipart(key, uploadId, parts) {
      if (parts.length === 0) {
        throw new Error(
          `S3 completeMultipart called with empty parts list for key=${JSON.stringify(key)} uploadId=${uploadId}`,
        );
      }
      // S3 requires Parts in ascending PartNumber order; sort defensively
      // so a stray out-of-order entry from the caller doesn't fail the whole
      // session.
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const res = await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
      );
      // Defensive: aws-sdk-js v3 surfaces most `<Error>` bodies as thrown
      // errors via the deserialiser, but a 200 with an empty/missing ETag
      // indicates the upload did not actually assemble. Treat as failure
      // rather than silently returning an empty etag.
      const etag = res.ETag;
      if (!etag || etag.length === 0) {
        throw new Error(
          `S3 CompleteMultipartUpload returned 200 with no ETag for key=${JSON.stringify(key)} uploadId=${uploadId} — likely an error body; treating as failure.`,
        );
      }
      sessions.delete(uploadId);
      return { etag };
    },

    async abortMultipart(key, uploadId) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          }),
        );
      } catch (err: unknown) {
        // NoSuchUpload / 404 — the upload was already aborted (sweep, cascade,
        // or a parallel cleanup path). Idempotent: success.
        if (errorHttpStatus(err) === 404) {
          // swallow
        } else {
          throw err;
        }
      } finally {
        sessions.delete(uploadId);
      }
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
 */
export async function verifyS3Storage(
  provider: StorageProvider,
  config: S3StorageConfig,
): Promise<void> {
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
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch (err: unknown) {
    const status = errorHttpStatus(err);
    const detail = errorMessage(err);
    if (status === 404) {
      throw new Error(
        `Storage bootstrap failed: bucket '${config.bucket}' not found at ${config.endpoint}. ` +
          `Create the bucket or correct S3_BUCKET. (HeadBucket → 404)`,
      );
    }
    if (status === 403) {
      throw new Error(
        `Storage bootstrap failed: access denied to bucket '${config.bucket}' at ${config.endpoint}. ` +
          `Check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY and bucket policy. (HeadBucket → 403)`,
      );
    }
    throw new Error(
      `Storage bootstrap failed: HeadBucket on '${config.bucket}' at ${config.endpoint} ` +
        `failed (${status ?? 'no-status'}): ${detail}`,
    );
  } finally {
    client.destroy();
  }
  // `provider` is accepted for symmetry with the verifier switcher; it is not
  // referenced because the HeadBucket probe uses a one-shot client.
  void provider;
}

function isNotFoundError(err: unknown): boolean {
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
