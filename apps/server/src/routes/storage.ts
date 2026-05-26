import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';

import type { LocalStorageConfig } from '../config.js';
import { resolveSafe } from '../storage/local.js';
import { validateKey, verifySignature, type CanonicalMethod } from '../storage/signing.js';

/**
 * Public storage routes for the local backend. Mounted at `/api/storage/o`
 * only when `config.storage.backend === 'local'`.
 *
 * URL shape (matches `LocalStorageProvider`):
 *   PUT    /api/storage/o/put/<key>     — accept body, atomic write.
 *   GET    /api/storage/o/get/<key>     — serve body with Range support. (slice 2)
 *   DELETE /api/storage/o/delete/<key>  — idempotent unlink. (slice 3)
 *
 * Every URL is HMAC-signed. The signature binds the request method, key,
 * expiry, and (when set) `Content-Type` / `Content-Length` /
 * response-content-disposition. A mismatch → 403. This mirrors the security
 * property of an S3 SigV4 URL: possession of the URL is the authorization,
 * and a client cannot deviate from what the server promised it would accept.
 */
export function createLocalStorageRoute(config: LocalStorageConfig): Hono {
  const objectsDir = config.objectsDir;
  const secret = config.signingSecret;
  const route = new Hono();

  route.put('/put/:key{.+}', async (c) => {
    const key = c.req.param('key');
    if (!validateKey(key)) {
      return c.json({ error: 'invalid_key' }, 400);
    }

    const sigCheck = checkSignature(c, 'PUT', key, secret);
    if (!sigCheck.ok) return c.json({ error: sigCheck.error }, sigCheck.status);

    const { contentType: signedCt, contentLength: signedCl } = sigCheck;

    // Header parity: an S3 SigV4 PUT rejects on mismatched Content-Type /
    // Content-Length because those headers are part of the signature. We
    // emulate the same property here so a client cannot deviate from what
    // the server promised it would store.
    if (signedCt !== undefined) {
      const headerCt = c.req.header('content-type');
      if (headerCt !== signedCt) {
        return c.json({ error: 'content_type_mismatch' }, 403);
      }
    }
    if (signedCl !== undefined) {
      const headerClRaw = c.req.header('content-length');
      const headerCl = headerClRaw ? Number.parseInt(headerClRaw, 10) : NaN;
      if (!Number.isInteger(headerCl) || headerCl !== signedCl) {
        return c.json({ error: 'content_length_mismatch' }, 403);
      }
    }

    const targetPath = resolveSafe(objectsDir, key);
    if (targetPath === null) {
      return c.json({ error: 'invalid_key' }, 400);
    }

    const body = c.req.raw.body;
    if (!body) {
      return c.json({ error: 'no_body' }, 400);
    }

    await fs.mkdir(dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.tmp-${randomBytes(8).toString('hex')}`;

    const hash = createHash('sha256');
    let bytesReceived = 0;
    let overrun = false;

    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(tmpPath, 'w');

      // Iterate the Web ReadableStream Hono exposes via `c.req.raw.body`. It
      // is async-iterable in Node 18+ and yields `Uint8Array` chunks. We
      // write each chunk directly through the FileHandle (`handle.write`)
      // instead of going through a Node WriteStream — wrapping a FileHandle
      // in a WriteStream creates an ownership tangle that empirically can
      // deadlock the subsequent `handle.close()`.
      //
      // We do not use `Readable.fromWeb` + `pipeline()` either: the
      // @hono/node-server adapter does not reliably surface the EOF of the
      // wrapped IncomingMessage to `Readable.fromWeb`, which can leave the
      // pipeline waiting on an end event that never arrives.
      const reader = body as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of reader) {
        const len = chunk.byteLength;
        bytesReceived += len;
        // Disk-fill DoS guard: cancel as soon as the body exceeds what was
        // signed. The server NEVER trusts a client to honour its declared
        // length — counting bytes is the enforcement.
        if (signedCl !== undefined && bytesReceived > signedCl) {
          overrun = true;
          break;
        }
        hash.update(chunk);
        await handle.write(chunk);
      }

      if (overrun) {
        await handle.close();
        handle = null;
        await fs.unlink(tmpPath).catch(() => {});
        return c.json({ error: 'length_overrun' }, 400);
      }

      // fsync the data before rename — a crash between rename and fsync
      // could otherwise leave a zero-length file at the final path on
      // certain filesystems.
      await handle.sync();
      await handle.close();
      handle = null;

      if (signedCl !== undefined && bytesReceived !== signedCl) {
        await fs.unlink(tmpPath).catch(() => {});
        return c.json({ error: 'length_mismatch' }, 400);
      }

      // Atomic rename. `fs.rename` is atomic on POSIX when source and target
      // are on the same filesystem — they always are here (both under
      // `objectsDir`).
      await fs.rename(tmpPath, targetPath);

      // Best-effort sidecar. The DB has the upload-ticket row carrying the
      // canonical content-type, and `fs.stat` can recover size; the sidecar
      // is purely an optimisation so `headObject` does not need to consult
      // the DB. A failure here does not roll back the upload.
      const etag = hash.digest('hex');
      const meta = {
        contentType: signedCt ?? null,
        etag,
        size: bytesReceived,
      };
      try {
        await fs.writeFile(`${targetPath}.meta.json`, JSON.stringify(meta));
      } catch (err) {
        console.warn('[storage] meta sidecar write failed', { key, err });
      }

      return c.body(null, 200);
    } catch (err: unknown) {
      if (handle !== null) {
        await handle.close().catch(() => {});
      }
      await fs.unlink(tmpPath).catch(() => {});
      console.error('[storage] PUT failed', { key, err });
      const message = err instanceof Error ? err.message : 'unknown';
      return c.json({ error: 'write_failed', message }, 500);
    }
  });

  route.get('/get/:key{.+}', async (c) => {
    const key = c.req.param('key');
    if (!validateKey(key)) {
      return c.json({ error: 'invalid_key' }, 400);
    }

    const sigCheck = checkSignature(c, 'GET', key, secret);
    if (!sigCheck.ok) return c.json({ error: sigCheck.error }, sigCheck.status);

    const targetPath = resolveSafe(objectsDir, key);
    if (targetPath === null) {
      return c.json({ error: 'invalid_key' }, 400);
    }

    let size: number;
    try {
      const st = await fs.stat(targetPath);
      size = st.size;
    } catch (err: unknown) {
      if (isEnoent(err)) return c.json({ error: 'not_found' }, 404);
      throw err;
    }

    // Content-Type from the meta sidecar; fall back to a safe generic.
    let contentType = 'application/octet-stream';
    try {
      const raw = await fs.readFile(`${targetPath}.meta.json`, 'utf8');
      const meta = JSON.parse(raw) as { contentType?: unknown };
      if (typeof meta.contentType === 'string' && meta.contentType.length > 0) {
        contentType = meta.contentType;
      }
    } catch {
      // Sidecar absent or malformed — fall back is fine.
    }

    const baseHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    };
    if (sigCheck.responseContentDisposition !== undefined) {
      baseHeaders['Content-Disposition'] = sigCheck.responseContentDisposition;
    }

    const rangeHeader = c.req.header('range');
    const rangeResult = parseRange(rangeHeader, size);

    if (rangeResult === 'unsatisfiable') {
      // RFC 7233 §4.4: include `Content-Range: bytes */<size>` so the client
      // can recover (it now knows the actual size).
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
      });
    }

    if (rangeResult === null) {
      // No `Range` header, or malformed — RFC 7233 §3.1 says ignore a
      // malformed Range and respond with the full body. Same as S3.
      const headers = { ...baseHeaders, 'Content-Length': String(size) };
      const stream = createReadStream(targetPath);
      const webBody = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
      return new Response(webBody, { status: 200, headers });
    }

    const { start, end } = rangeResult;
    const headers = {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    };
    const stream = createReadStream(targetPath, { start, end });
    const webBody = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    return new Response(webBody, { status: 206, headers });
  });

  route.delete('/delete/:key{.+}', async (c) => {
    const key = c.req.param('key');
    if (!validateKey(key)) {
      return c.json({ error: 'invalid_key' }, 400);
    }

    const sigCheck = checkSignature(c, 'DELETE', key, secret);
    if (!sigCheck.ok) return c.json({ error: sigCheck.error }, sigCheck.status);

    const targetPath = resolveSafe(objectsDir, key);
    if (targetPath === null) {
      return c.json({ error: 'invalid_key' }, 400);
    }

    // Idempotent: ENOENT is success. Matches S3 DeleteObject semantics so the
    // admin "delete file" flow and the ticket-cleanup sweep (#10) don't need
    // to special-case "already deleted".
    try {
      await fs.unlink(targetPath);
    } catch (err: unknown) {
      if (!isEnoent(err)) {
        console.error('[storage] DELETE failed', { key, err });
        const message = err instanceof Error ? err.message : 'unknown';
        return c.json({ error: 'delete_failed', message }, 500);
      }
    }
    // Best-effort sidecar cleanup; missing sidecar is not an error.
    await fs.unlink(`${targetPath}.meta.json`).catch(() => {});

    return c.body(null, 204);
  });

  return route;
}

/**
 * Parse an HTTP `Range` header for a single byte-range.
 *
 *   - `bytes=N-M`  → byte N to byte M (inclusive)
 *   - `bytes=N-`   → byte N to end of file
 *   - `bytes=-N`   → suffix range: last N bytes (RFC 7233 §2.1)
 *
 * Returns:
 *   - `{ start, end }`  → valid, in-bounds range (end clamped to size-1).
 *   - `'unsatisfiable'` → 416 case (e.g. `start >= size`).
 *   - `null`            → no header, malformed, multi-range, or syntactically
 *                         valid but semantically empty. The caller serves
 *                         the full body in this case (matches S3).
 */
export function parseRange(
  raw: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Multi-range syntax (`bytes=0-10,20-30`) is intentionally not supported;
  // S3 also serves a single range or the full object, never multipart/byteranges.
  if (trimmed.includes(',')) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!m) return null;
  const startStr = m[1] ?? '';
  const endStr = m[2] ?? '';

  if (startStr === '' && endStr === '') return null;

  // Suffix range: `bytes=-N` → last N bytes.
  if (startStr === '') {
    const n = Number.parseInt(endStr, 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (size === 0) return 'unsatisfiable';
    const start = Math.max(0, size - n);
    return { start, end: size - 1 };
  }

  const start = Number.parseInt(startStr, 10);
  if (!Number.isInteger(start) || start < 0) return null;
  if (start >= size) return 'unsatisfiable';

  if (endStr === '') {
    return { start, end: size - 1 };
  }

  const end = Number.parseInt(endStr, 10);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

interface SignatureOk {
  ok: true;
  contentType: string | undefined;
  contentLength: number | undefined;
  responseContentDisposition: string | undefined;
}
interface SignatureFail {
  ok: false;
  error: string;
  status: 400 | 403;
}

/**
 * Parse the signed envelope from the URL, validate `exp`, then verify the
 * HMAC. Shared by every storage route (PUT here; GET in slice 2, DELETE in
 * slice 3 reuse this). Returning the signed values lets the caller enforce
 * the matching-header property without re-parsing the query string.
 */
export function checkSignature(
  c: { req: { url: string } },
  method: CanonicalMethod,
  key: string,
  secret: string,
): SignatureOk | SignatureFail {
  const url = new URL(c.req.url);
  const expRaw = url.searchParams.get('exp');
  const ctRaw = url.searchParams.get('ct');
  const clRaw = url.searchParams.get('cl');
  const cdRaw = url.searchParams.get('cd');
  const sigRaw = url.searchParams.get('sig');

  if (!expRaw || !sigRaw) return { ok: false, error: 'invalid_signature', status: 403 };
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isInteger(exp) || exp <= 0) {
    return { ok: false, error: 'invalid_signature', status: 403 };
  }
  if (exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'expired', status: 403 };
  }

  let contentLength: number | undefined;
  if (clRaw !== null) {
    const n = Number.parseInt(clRaw, 10);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: 'invalid_signature', status: 403 };
    }
    contentLength = n;
  }

  const contentType = ctRaw ?? undefined;
  const responseContentDisposition = cdRaw ?? undefined;

  const verified = verifySignature(
    { method, key, exp, contentType, contentLength, responseContentDisposition },
    sigRaw,
    secret,
  );
  if (!verified) return { ok: false, error: 'invalid_signature', status: 403 };

  return { ok: true, contentType, contentLength, responseContentDisposition };
}
