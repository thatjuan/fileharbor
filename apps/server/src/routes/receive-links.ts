import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { FilesModule } from '../files/files.js';
import type { ReceiveLinksModule } from '../links/receive-links.js';

interface CreateBody {
  label?: unknown;
}

/**
 * Admin (authed) routes over `receive_links`. Mounted at `/api/receive-links`.
 *
 *  - `POST   /`        — create a link from `{ label }`. Returns full row.
 *  - `GET    /`        — list links (newest first).
 *  - `GET    /:id`     — link detail + recent files.
 *
 * Everything here is gated by `requireAdmin`. The public surface
 * (`/api/public/receive-links/:code`) is its own router.
 */
export function createReceiveLinksRoute(
  authModule: AuthModule,
  receiveLinksModule: ReceiveLinksModule,
  filesModule: FilesModule,
): Hono<AdminContext> {
  const route = new Hono<AdminContext>();

  route.use('*', requireAdmin(authModule));

  route.post('/', async (c) => {
    let body: CreateBody;
    try {
      body = (await c.req.json()) as CreateBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const label = typeof body.label === 'string' ? body.label : '';
    try {
      const link = await receiveLinksModule.create({ label });
      return c.json({ link });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      // `label_required` / `label_too_long` are the only thrown shapes today;
      // both are user-fixable 400s.
      return c.json({ error: 'invalid_input', message }, 400);
    }
  });

  route.get('/', async (c) => {
    const links = await receiveLinksModule.list();
    return c.json({ links });
  });

  route.get('/:id', async (c) => {
    const id = c.req.param('id');
    const link = await receiveLinksModule.getById(id);
    if (!link) return c.json({ error: 'not_found' }, 404);
    const filesList = await filesModule.listForReceiveLink(link.id);
    return c.json({ link, files: filesList });
  });

  return route;
}
