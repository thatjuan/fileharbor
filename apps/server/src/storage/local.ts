import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { LocalStorageConfig } from '../config.js';
import type {
  CompletedPart,
  CompleteMultipartResult,
  InitMultipartOptions,
  InitMultipartResult,
  ObjectInfo,
  PresignedUrl,
  PresignUploadPartOptions,
  StorageProvider,
} from './index.js';
import { signCanonical, validateKey } from './signing.js';

/**
 * Strict format for the local backend's multipart `uploadId`: 32 lowercase
 * hex chars (128 bits of entropy from `randomUUID()` with hyphens stripped).
 * Exported so the part-receive route can reuse the same validator at the
 * URL boundary.
 */
export const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/;

/**
 * On-disk shape of `${objectsDir}/.multipart/<uploadId>/meta.json`. Written
 * once at init and read by every subsequent operation on the session.
 */
interface MultipartMeta {
  key: string;
  contentType: string;
  partSize: number;
  sizeHint: number;
  expectedParts: number;
  createdAt: number;
}

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

    async initMultipart(
      key: string,
      opts: InitMultipartOptions,
    ): Promise<InitMultipartResult> {
      if (!validateKey(key)) {
        throw new Error(
          `invalid storage key for local backend: ${JSON.stringify(key)} ` +
            `(allowed: [A-Za-z0-9._/-], no leading /, no //, no . or .. segments)`,
        );
      }
      if (!Number.isInteger(opts.sizeHint) || opts.sizeHint <= 0) {
        throw new Error(`initMultipart requires positive integer sizeHint`);
      }
      // Same resolution as S3: never below caller's configured floor, and
      // large enough to keep the part count <= 10_000.
      const partSize = Math.max(
        opts.partSizeBytes,
        Math.ceil(opts.sizeHint / 10_000),
      );
      const expectedParts = Math.ceil(opts.sizeHint / partSize);
      const uploadId = randomUUID().replace(/-/g, '');
      const sessionDir = join(objectsDir, '.multipart', uploadId);
      await fs.mkdir(sessionDir, { recursive: true });

      const meta: MultipartMeta = {
        key,
        contentType: opts.contentType,
        partSize,
        sizeHint: opts.sizeHint,
        expectedParts,
        createdAt: Math.floor(Date.now() / 1000),
      };
      // Atomic write-then-rename so a crash mid-write doesn't leave a torn
      // JSON. `fs.writeFile` does NOT fsync — go through an open handle so
      // the bytes are durable on disk before the rename commits.
      const metaTmp = join(
        sessionDir,
        `meta.json.tmp-${randomBytes(8).toString('hex')}`,
      );
      const metaHandle = await fs.open(metaTmp, 'w');
      try {
        await metaHandle.writeFile(JSON.stringify(meta));
        await metaHandle.sync();
      } finally {
        await metaHandle.close();
      }
      await fs.rename(metaTmp, join(sessionDir, 'meta.json'));

      return { uploadId, partSize, expectedParts };
    },

    async presignUploadPart(
      key: string,
      uploadId: string,
      partNumber: number,
      opts?: PresignUploadPartOptions,
    ): Promise<PresignedUrl> {
      if (!UPLOAD_ID_PATTERN.test(uploadId)) {
        throw new Error(
          `invalid uploadId for local backend: ${JSON.stringify(uploadId)}`,
        );
      }
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > 10_000
      ) {
        throw new Error(`partNumber out of range: ${partNumber}`);
      }
      if (!validateKey(key)) {
        throw new Error(
          `invalid storage key for local backend: ${JSON.stringify(key)}`,
        );
      }

      const sessionDir = join(objectsDir, '.multipart', uploadId);
      const metaRaw = await fs.readFile(join(sessionDir, 'meta.json'), 'utf8');
      const meta = JSON.parse(metaRaw) as MultipartMeta;
      // Defends against a confused caller that mints a part URL for a
      // different key than the session was opened for. The route layer also
      // recovers `key` from meta.json, but binding it into the signature
      // here means a leaked URL cannot be re-pointed.
      if (meta.key !== key) {
        throw new Error(
          `uploadId ${uploadId} does not belong to key=${JSON.stringify(key)}`,
        );
      }
      if (partNumber > meta.expectedParts) {
        throw new Error(
          `partNumber ${partNumber} exceeds expectedParts ${meta.expectedParts}`,
        );
      }

      // Per-part Content-Length is server-derived from session state. Every
      // part except the last is exactly `partSize`; the last is whatever
      // remains. Off-by-one here silently truncates uploads — verify by
      // hand: sizeHint=33, partSize=16 → expectedParts=3, last part=33-32=1.
      const contentLength =
        partNumber === meta.expectedParts
          ? meta.sizeHint - (meta.expectedParts - 1) * meta.partSize
          : meta.partSize;

      const exp = Math.floor(Date.now() / 1000) + ttlFor(opts?.expiresInSeconds);
      const sig = signCanonical(
        {
          method: 'PUT-PART',
          key,
          exp,
          contentLength,
          uploadId,
          partNumber,
        },
        secret,
      );
      const q = new URLSearchParams();
      q.set('exp', String(exp));
      q.set('cl', String(contentLength));
      q.set('sig', sig);
      // No `ct` query parameter — R3: part PUTs are content-type-blind.
      const url = `/api/storage/o/multipart/part/${uploadId}/${partNumber}?${q.toString()}`;
      return { url, expiresAt: new Date(exp * 1000) };
    },

    async completeMultipart(
      key: string,
      uploadId: string,
      parts: CompletedPart[],
    ): Promise<CompleteMultipartResult> {
      if (!UPLOAD_ID_PATTERN.test(uploadId)) {
        throw new Error(
          `invalid uploadId for local backend: ${JSON.stringify(uploadId)}`,
        );
      }
      if (!validateKey(key)) {
        throw new Error(
          `invalid storage key for local backend: ${JSON.stringify(key)}`,
        );
      }
      if (parts.length === 0) {
        throw new Error(
          `local completeMultipart called with empty parts list for key=${JSON.stringify(key)} uploadId=${uploadId}`,
        );
      }

      const sessionDir = join(objectsDir, '.multipart', uploadId);
      const meta = JSON.parse(
        await fs.readFile(join(sessionDir, 'meta.json'), 'utf8'),
      ) as MultipartMeta;
      if (meta.key !== key) {
        throw new Error(
          `uploadId ${uploadId} does not belong to key=${JSON.stringify(key)}`,
        );
      }

      // Validate the parts list: ascending 1..N, no gaps, exact count.
      if (parts.length !== meta.expectedParts) {
        throw new Error(
          `part count mismatch: got ${parts.length}, expected ${meta.expectedParts}`,
        );
      }
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i]!.partNumber !== i + 1) {
          throw new Error(
            `part list has gap or duplicate at index ${i} (partNumber=${sorted[i]!.partNumber})`,
          );
        }
      }

      // Verify every part file is present before opening the target. Cheap
      // pre-flight so we don't create a tmp file just to delete it on a
      // trivially-detectable failure.
      for (const p of sorted) {
        const partPath = join(sessionDir, `${p.partNumber}.part`);
        try {
          await fs.stat(partPath);
        } catch (err: unknown) {
          if (isEnoent(err)) {
            throw new Error(`missing_part: ${p.partNumber}`);
          }
          throw err;
        }
      }

      const targetPath = resolveSafe(objectsDir, key);
      if (targetPath === null) {
        throw new Error(`invalid key resolution: ${JSON.stringify(key)}`);
      }
      await fs.mkdir(dirname(targetPath), { recursive: true });
      const tmpPath = `${targetPath}.tmp-${randomBytes(8).toString('hex')}`;

      const hash = createHash('sha256');
      let totalBytes = 0;
      // Streaming concatenation through a single FileHandle. Reuse the same
      // anti-deadlock pattern documented at `routes/storage.ts:81-129`:
      // iterate the readable's chunks ourselves and `handle.write` each one.
      // Do NOT wrap the handle in a WriteStream or use `Readable.pipeline` /
      // `Readable.toWeb` — those produce ownership tangles that empirically
      // deadlock the subsequent `handle.close()`.
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        handle = await fs.open(tmpPath, 'w');
        for (const p of sorted) {
          const partPath = join(sessionDir, `${p.partNumber}.part`);
          const reader = createReadStream(partPath);
          for await (const chunk of reader as AsyncIterable<Buffer>) {
            hash.update(chunk);
            await handle.write(chunk);
            totalBytes += chunk.byteLength;
          }
        }
        if (totalBytes !== meta.sizeHint) {
          throw new Error(
            `total bytes ${totalBytes} != sizeHint ${meta.sizeHint}`,
          );
        }
        // fsync before rename — a crash between rename and fsync could
        // otherwise leave a zero-length file at the final path on certain
        // filesystems.
        await handle.sync();
      } catch (err) {
        if (handle !== null) {
          await handle.close().catch(() => {});
          handle = null;
        }
        await fs.unlink(tmpPath).catch(() => {});
        // Do NOT remove the session dir on failure — sweep or an explicit
        // abort owns that cleanup. Propagating the error is enough.
        throw err;
      }
      // Closed in success path here (the catch handles the failure path).
      await handle.close();

      // Atomic rename onto the final key. `fs.rename` is atomic on POSIX
      // when source and target share a filesystem (they always do — both
      // under objectsDir).
      await fs.rename(tmpPath, targetPath);

      // Final etag is hex sha256 — same encoding the single-PUT route
      // writes (routes/storage.ts:135-145), so `headObject` returns a
      // consistent shape regardless of which path put the bytes there.
      const etag = hash.digest('hex');
      const sidecar = {
        contentType: meta.contentType,
        etag,
        size: totalBytes,
      };
      try {
        await fs.writeFile(`${targetPath}.meta.json`, JSON.stringify(sidecar));
      } catch (err) {
        console.warn('[storage] multipart meta sidecar write failed', { key, err });
      }

      // Drop the session dir. Failure here is logged, not fatal — sweep
      // handles orphaned `.multipart/*` dirs as a backstop.
      try {
        await fs.rm(sessionDir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[storage] multipart session cleanup failed', { uploadId, err });
      }

      return { etag };
    },

    async abortMultipart(_key: string, uploadId: string): Promise<void> {
      // The interface signature requires `key` for symmetry with S3, but
      // the local backend identifies the session by `uploadId` alone — the
      // `.multipart/<uploadId>/` dir holds all state. Ignored here.
      if (!UPLOAD_ID_PATTERN.test(uploadId)) {
        throw new Error(
          `invalid uploadId for local backend: ${JSON.stringify(uploadId)}`,
        );
      }
      const sessionDir = join(objectsDir, '.multipart', uploadId);
      // `force: true` swallows ENOENT — abort on a non-existent session is
      // success (idempotent), matching S3's NoSuchUpload semantics.
      await fs.rm(sessionDir, { recursive: true, force: true });
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
