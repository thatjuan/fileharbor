import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytesReceived += chunk.length;
        // Disk-fill DoS guard: if the request body exceeds the signed length,
        // cancel the stream, unlink the temp file, and respond 400. The
        // server NEVER trusts a client to honour the length it signed —
        // counting bytes is the actual enforcement.
        if (signedCl !== undefined && bytesReceived > signedCl) {
          overrun = true;
          cb(new Error('length_overrun'));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(tmpPath, 'w');
      const writeStream = handle.createWriteStream({ autoClose: false });
      // `Readable.fromWeb` converts the Web ReadableStream that Hono's Node
      // adapter exposes via `c.req.raw.body` into a Node Readable so we can
      // run it through `pipeline()` for backpressure + error propagation.
      // The cast goes through `unknown` because the TS lib types for
      // `Readable.fromWeb` and the global `ReadableStream` come from
      // different upstreams.
      const nodeBody = Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      await pipeline(nodeBody, counter, writeStream);

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
      if (overrun) return c.json({ error: 'length_overrun' }, 400);
      console.error('[storage] PUT failed', { key, err });
      const message = err instanceof Error ? err.message : 'unknown';
      return c.json({ error: 'write_failed', message }, 500);
    }
  });

  return route;
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
