import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
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
