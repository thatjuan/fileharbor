import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { NotificationsModule } from '../notifications/notifications.js';

/**
 * Admin notifications endpoints. Mounted at `/api/notifications`.
 *
 *   - `GET  /?unreadOnly=true|false&limit=N` — recent items plus the current
 *     unread count. The count is returned alongside the list so the bell can
 *     update from a single round-trip (no second `?unreadOnly=true` fetch
 *     needed after rendering the panel).
 *
 *   - `POST /mark-read` — body `{ ids: string[] }` to mark specific items, or
 *     `{ all: true }` for the bulk affordance. Returns both `markedCount`
 *     (rows actually flipped) and the post-update `unreadCount` so the bell
 *     stays consistent without a follow-up GET.
 *
 * Bodies are validated narrowly — anything else returns 400. The route never
 * surfaces the row count for the read action as anything other than a number
 * of state transitions; double-clicking "mark read" returns 0 the second time.
 */
interface MarkReadBody {
  ids?: unknown;
  all?: unknown;
}

export function createNotificationsRoute(
  authModule: AuthModule,
  notificationsModule: NotificationsModule,
): Hono<AdminContext> {
  const route = new Hono<AdminContext>();

  route.use('*', requireAdmin(authModule));

  route.get('/', async (c) => {
    const unreadOnly = c.req.query('unreadOnly') === 'true';
    const limitParam = c.req.query('limit');
    const limit = limitParam !== undefined ? Number.parseInt(limitParam, 10) : undefined;

    const list = await notificationsModule.list({ unreadOnly, limit });
    const unreadCount = await notificationsModule.unreadCount();
    return c.json({ notifications: list, unreadCount });
  });

  route.post('/mark-read', async (c) => {
    let body: MarkReadBody;
    try {
      body = (await c.req.json()) as MarkReadBody;
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }

    let markedCount: number;
    if (body.all === true) {
      markedCount = await notificationsModule.markAllRead();
    } else if (Array.isArray(body.ids)) {
      // Filter to strings to be defensive against caller noise; an array
      // containing `null` shouldn't 500 the endpoint.
      const ids = body.ids.filter((id): id is string => typeof id === 'string');
      markedCount = await notificationsModule.markRead(ids);
    } else {
      return c.json({ error: 'invalid_body', message: 'expected { ids: string[] } or { all: true }' }, 400);
    }

    const unreadCount = await notificationsModule.unreadCount();
    return c.json({ markedCount, unreadCount });
  });

  return route;
}
