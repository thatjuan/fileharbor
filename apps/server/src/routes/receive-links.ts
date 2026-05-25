import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { FilesModule } from '../files/files.js';
import type { ReceiveLink, ReceiveLinksModule } from '../links/receive-links.js';

interface CreateBody {
  label?: unknown;
  password?: unknown;
  maxUploads?: unknown;
  expiresAt?: unknown;
}

/**
 * Shape of a receive link as returned over the wire. Strips `passwordHash`
 * (PRD: the API never returns the hash) and surfaces a derived
 * `passwordProtected` boolean for the admin UI to render the lock icon.
 */
interface ReceiveLinkResponse {
  id: string;
  code: string;
  label: string;
  passwordProtected: boolean;
  maxUploads: number | null;
  expiresAt: number | null;
  status: 'active' | 'disabled';
  createdAt: number;
}

function toResponse(link: ReceiveLink): ReceiveLinkResponse {
  return {
    id: link.id,
    code: link.code,
    label: link.label,
    passwordProtected: link.passwordHash !== null,
    maxUploads: link.maxUploads,
    expiresAt: link.expiresAt,
    status: link.status,
    createdAt: link.createdAt,
  };
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

    // Each policy field is independently optional. An absent/null/empty value
    // means "no constraint"; a present value is validated by the module.
    const password = typeof body.password === 'string' ? body.password : null;
    const maxUploads = typeof body.maxUploads === 'number' ? body.maxUploads : null;
    const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : null;

    try {
      const link = await receiveLinksModule.create({ label, password, maxUploads, expiresAt });
      return c.json({ link: toResponse(link) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      // Thrown shapes: `label_required`, `label_too_long`,
      // `invalid_max_uploads`, `invalid_expires_at`. All user-fixable 400s.
      return c.json({ error: 'invalid_input', message }, 400);
    }
  });

  route.get('/', async (c) => {
    const links = await receiveLinksModule.list();
    return c.json({ links: links.map(toResponse) });
  });

  route.get('/:id', async (c) => {
    const id = c.req.param('id');
    const link = await receiveLinksModule.getById(id);
    if (!link) return c.json({ error: 'not_found' }, 404);
    const filesList = await filesModule.listForReceiveLink(link.id);
    const uploadsSoFar = await receiveLinksModule.recordUploadCount(link.id);
    return c.json({ link: toResponse(link), files: filesList, uploadsSoFar });
  });

  return route;
}
