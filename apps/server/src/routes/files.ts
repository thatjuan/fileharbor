import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { FilesModule } from '../files/files.js';

/**
 * Admin file routes. Mounted at `/api/files`.
 *
 * Only `GET /:id` for #5 — enough for the dashboard's link detail view to
 * link to a single file. Download/delete land in #7.
 */
export function createFilesRoute(
  authModule: AuthModule,
  filesModule: FilesModule,
): Hono<AdminContext> {
  const route = new Hono<AdminContext>();

  route.use('*', requireAdmin(authModule));

  route.get('/:id', async (c) => {
    const id = c.req.param('id');
    const file = await filesModule.getById(id);
    if (!file) return c.json({ error: 'not_found' }, 404);
    return c.json({ file });
  });

  return route;
}
