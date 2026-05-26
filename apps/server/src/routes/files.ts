import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { FilesModule } from '../files/files.js';
import type { StorageProvider } from '../storage/index.js';

/**
 * Admin file routes. Mounted at `/api/files`.
 *
 *  - `GET    /:id`            — JSON metadata for a single file.
 *  - `GET    /:id/download`   — mint a presigned GET so the admin can
 *                               download direct from the bucket. Returns
 *                               `{ url, expiresAt, filename, size, contentType }`;
 *                               the frontend navigates to `url` (or uses
 *                               `<a download>`).
 *                               `responseContentDisposition` is set so the
 *                               browser saves with the friendly filename
 *                               instead of the opaque S3 key.
 *  - `DELETE /:id`            — delete the S3 object first, then the DB row.
 *                               Order rationale below.
 *
 * Delete order — S3 first, then DB:
 *   - If S3 succeeds and DB delete then fails (vanishingly unlikely on
 *     SQLite, but the contract still applies), the DB row points at a key
 *     that no longer exists. The next download attempt 404s from S3; the
 *     admin can retry the delete and the row will go away.
 *   - If S3 fails (auth, bucket misconfig), we never touch the DB row.
 *     The endpoint returns an error and the file stays visible — the admin
 *     can investigate without ending up with an orphan in the bucket.
 *   - The opposite order — DB first — would leave bucket leftovers on a
 *     half-failure, with no DB row to point at them. That's much worse to
 *     reconcile than a stale row referencing nothing.
 *
 * `deleteObject` on a missing key: S3 returns 204 (success) for an already-
 * gone key, so we don't need to special-case "already deleted". A `NotFound`
 * from a misbehaving provider is still surfaced as a DB row that points at
 * nothing — same recoverable state.
 */
export function createFilesRoute(
  authModule: AuthModule,
  filesModule: FilesModule,
  storage: StorageProvider,
): Hono<AdminContext> {
  const route = new Hono<AdminContext>();

  route.use('*', requireAdmin(authModule));

  route.get('/:id', async (c) => {
    const id = c.req.param('id');
    const file = await filesModule.getById(id);
    if (!file) return c.json({ error: 'not_found' }, 404);
    return c.json({ file });
  });

  route.get('/:id/download', async (c) => {
    const id = c.req.param('id');
    const file = await filesModule.getById(id);
    if (!file) return c.json({ error: 'not_found' }, 404);

    // `attachment; filename="..."` so the browser saves with the friendly
    // name instead of the bucket key. RFC 6266 says quoted-string is enough
    // for ASCII; we strip quotes/backslashes to avoid breaking the header
    // and to dodge response-header injection on a maliciously-named file.
    const safeName = file.filename.replace(/[\\"\r\n]/g, '_');
    const presigned = await storage.presignGet(file.s3Key, {
      responseContentDisposition: `attachment; filename="${safeName}"`,
    });

    return c.json({
      url: presigned.url,
      expiresAt: presigned.expiresAt.toISOString(),
      filename: file.filename,
      size: file.size,
      contentType: file.contentType,
    });
  });

  route.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const file = await filesModule.getById(id);
    if (!file) return c.json({ error: 'not_found' }, 404);

    try {
      await storage.deleteObject(file.s3Key);
    } catch (err) {
      // S3 delete failed. Leave the DB row alone — admin retries land in the
      // same code path; manual investigation is possible because the row is
      // still visible. The precise SDK error can be diagnosed from server logs.
      console.error('[files] deleteObject failed', { id, s3Key: file.s3Key, err });
      return c.json({ error: 'storage_delete_failed' }, 500);
    }

    await filesModule.deleteById(id);
    return c.body(null, 204);
  });

  return route;
}
