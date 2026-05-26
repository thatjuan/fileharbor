import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { LocalStorageConfig } from '../config.js';
import type { ObjectInfo, PresignedUrl, StorageProvider } from './index.js';
import { signCanonical, validateKey } from './signing.js';

/**
 * Local filesystem storage backend. Persists object bytes on the same data
 * volume that holds the SQLite DB; presigned URLs point at File Harbor's own
 * routes (`/api/storage/o/...`) rather than an external bucket.
 *
 * The four StorageProvider operations are URL-minting + filesystem reads
 * here. The HTTP routes that actually accept the PUT body, serve the GET
 * body, and unlink on DELETE live in `routes/storage.ts` and verify the
 * URL signatures using the same `signing.ts` helpers used here.
 *
 * On-disk layout:
 *   ${objectsDir}/<key>            — content file
 *   ${objectsDir}/<key>.meta.json  — { contentType, etag, size } sidecar
 *
 * The sidecar is best-effort: absence is tolerated and `headObject` returns
 * `null` for the missing fields. The interface contract already permits this.
 */
export function createLocalStorageProvider(config: LocalStorageConfig): StorageProvider {
  const objectsDir = resolve(config.objectsDir);
  const defaultTtl = config.presignTtlSeconds;
  const secret = config.signingSecret;

  function ttlFor(override: number | undefined): number {
    return override ?? defaultTtl;
  }

  function mintUrl(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    ttlSeconds: number,
    opts: {
      contentType?: string;
      contentLength?: number;
      responseContentDisposition?: string;
    },
  ): PresignedUrl {
    if (!validateKey(key)) {
      throw new Error(
        `invalid storage key for local backend: ${JSON.stringify(key)} ` +
          `(allowed: [A-Za-z0-9._/-], no leading /, no //, no . or .. segments)`,
      );
    }
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = signCanonical(
      {
        method,
        key,
        exp,
        contentType: opts.contentType,
        contentLength: opts.contentLength,
        responseContentDisposition: opts.responseContentDisposition,
      },
      secret,
    );
    const action = method === 'PUT' ? 'put' : method === 'GET' ? 'get' : 'delete';
    const q = new URLSearchParams();
    q.set('exp', String(exp));
    if (opts.contentType !== undefined) q.set('ct', opts.contentType);
    if (opts.contentLength !== undefined) q.set('cl', String(opts.contentLength));
    if (opts.responseContentDisposition !== undefined) q.set('cd', opts.responseContentDisposition);
    q.set('sig', sig);

    // Keys only contain chars from `[A-Za-z0-9._/-]`, none of which require
    // percent-encoding in a URL path. Forward slashes stay as segment
    // separators — that's the same shape the route handler matches.
    const url = `/api/storage/o/${action}/${key}?${q.toString()}`;
    return { url, expiresAt: new Date(exp * 1000) };
  }

  return {
    // Diagnostic label only. The `bucket` field is exposed by the interface
    // for logging; in local mode it identifies the on-disk root.
    bucket: `local:${objectsDir}`,
    defaultTtlSeconds: defaultTtl,

    async presignPut(key, opts) {
      return mintUrl('PUT', key, ttlFor(opts?.expiresInSeconds), {
        contentType: opts?.contentType,
        contentLength: opts?.contentLength,
      });
    },

    async presignGet(key, opts) {
      return mintUrl('GET', key, ttlFor(opts?.expiresInSeconds), {
        responseContentDisposition: opts?.responseContentDisposition,
      });
    },

    async presignDelete(key, opts) {
      return mintUrl('DELETE', key, ttlFor(opts?.expiresInSeconds), {});
    },

    async headObject(key): Promise<ObjectInfo | null> {
      if (!validateKey(key)) return null;
      const filePath = resolveSafe(objectsDir, key);
      if (filePath === null) return null;
      try {
        const st = await fs.stat(filePath);
        let contentType: string | null = null;
        let etag: string | null = null;
        try {
          const raw = await fs.readFile(`${filePath}.meta.json`, 'utf8');
          const parsed = JSON.parse(raw) as { contentType?: unknown; etag?: unknown };
          if (typeof parsed.contentType === 'string') contentType = parsed.contentType;
          if (typeof parsed.etag === 'string') etag = parsed.etag;
        } catch {
          // Sidecar missing or malformed — interface allows nulls.
        }
        return { size: st.size, contentType, etag, lastModified: st.mtime };
      } catch (err: unknown) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },

    async deleteObject(key) {
      if (!validateKey(key)) return;
      const filePath = resolveSafe(objectsDir, key);
      if (filePath === null) return;
      try {
        await fs.unlink(filePath);
      } catch (err: unknown) {
        if (!isEnoent(err)) throw err;
      }
      try {
        await fs.unlink(`${filePath}.meta.json`);
      } catch {
        // Best-effort.
      }
    },
  };
}

/**
 * Boot-time probe matching `verifyStorage`'s contract: create the objects
 * directory, write-and-unlink a probe file, throw a clear error on failure
 * so `main()` exits non-zero before any traffic is served.
 */
export async function verifyLocalStorage(config: LocalStorageConfig): Promise<void> {
  const dir = resolve(config.objectsDir);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    throw new Error(
      `Storage bootstrap failed: cannot create LOCAL_OBJECTS_DIR=${dir} ` +
        `(${errCode(err)}: ${errMessage(err)})`,
    );
  }
  const probe = join(dir, `.fileharbor-probe-${randomBytes(8).toString('hex')}`);
  try {
    await fs.writeFile(probe, 'ok');
  } catch (err: unknown) {
    throw new Error(
      `Storage bootstrap failed: cannot write to LOCAL_OBJECTS_DIR=${dir} ` +
        `(${errCode(err)}: ${errMessage(err)}). Check filesystem permissions on the data volume.`,
    );
  }
  try {
    await fs.unlink(probe);
  } catch {
    // Probe-cleanup failure is non-fatal; if write worked, the directory is usable.
  }
}

/**
 * Resolve a validated key to a filesystem path and assert the result lives
 * under `objectsDir`. Returns `null` on any boundary violation (defence in
 * depth: even though `validateKey` rejects `..` and other shenanigans, the
 * post-resolve prefix check is the canonical anti-traversal guard).
 */
export function resolveSafe(objectsDir: string, key: string): string | null {
  const rooted = resolve(objectsDir);
  const target = resolve(rooted, key);
  if (target !== rooted && !target.startsWith(rooted + sep)) return null;
  if (target === rooted) return null;
  return target;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function errCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: string }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
