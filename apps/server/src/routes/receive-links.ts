import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { FilesModule } from '../files/files.js';
import { logServerError, messageFromAllowedError } from '../http/errors.js';
import { evaluateReceiveLink } from '../links/policy/index.js';
import type { ReceiveLink, ReceiveLinksModule } from '../links/receive-links.js';

interface CreateBody {
  label?: unknown;
  password?: unknown;
  maxUploads?: unknown;
  expiresAt?: unknown;
}

interface UpdateBody {
  status?: unknown;
}

const RECEIVE_LINK_VALIDATION_ERRORS = [
  'label_required',
  'label_too_long',
  'invalid_max_uploads',
  'invalid_expires_at',
] as const;

/**
 * The four display statuses surfaced to the admin UI. Distinct from the row's
 * stored `status` (`active`/`disabled`): `expired` and `quota_exhausted` are
 * computed from policy + state, not persisted.
 *
 * Underscore form `quota_exhausted` to match the public ticket-mint error
 * shape (`PolicyRejection` on the web side) — one canonical string across the
 * wire; pretty-printing happens in the badge.
 */
type DisplayStatus = 'active' | 'expired' | 'quota_exhausted' | 'disabled';

/**
 * Shape of a receive link as returned over the wire. Strips `passwordHash`
 * (PRD: the API never returns the hash) and surfaces a derived
 * `passwordProtected` boolean for the admin UI to render the lock icon.
 *
 * `displayStatus` is the policy-computed verdict for badge rendering; see
 * `computeDisplayStatus`. We ship both `status` (the row's lifecycle flag)
 * and `displayStatus` because they answer different questions: `status` is
 * "what did the admin toggle this to"; `displayStatus` is "what would happen
 * if a stranger tried to upload right now".
 */
interface ReceiveLinkResponse {
  id: string;
  code: string;
  label: string;
  passwordProtected: boolean;
  maxUploads: number | null;
  expiresAt: number | null;
  status: 'active' | 'disabled';
  displayStatus: DisplayStatus;
  createdAt: number;
}

/**
 * Map a policy verdict into the four display statuses. The policy module
 * also reports `password_required` / `password_wrong`, but those are
 * per-attempt verdicts driven by uploader input — not states the dashboard
 * surfaces. We pass `password_check: 'not_required'` when computing display
 * status so policy never returns those branches.
 */
function computeDisplayStatus(link: ReceiveLink, uploadsSoFar: number): DisplayStatus {
  const verdict = evaluateReceiveLink(link, Math.floor(Date.now() / 1000), uploadsSoFar, {
    kind: 'not_required',
  });
  switch (verdict.kind) {
    case 'ok':
      return 'active';
    case 'disabled':
      return 'disabled';
    case 'expired':
      return 'expired';
    case 'quota_exhausted':
      return 'quota_exhausted';
    // The `not_required` branch above guarantees policy never returns these,
    // but the type system doesn't know that — fall through to the most
    // useful answer for a UI: if we can't compute a display reason, treat
    // the link as active.
    case 'password_required':
    case 'password_wrong':
      return 'active';
  }
}

function toResponse(link: ReceiveLink, uploadsSoFar: number): ReceiveLinkResponse {
  return {
    id: link.id,
    code: link.code,
    label: link.label,
    passwordProtected: link.passwordHash !== null,
    maxUploads: link.maxUploads,
    expiresAt: link.expiresAt,
    status: link.status,
    displayStatus: computeDisplayStatus(link, uploadsSoFar),
    createdAt: link.createdAt,
  };
}

/**
 * Admin (authed) routes over `receive_links`. Mounted at `/api/receive-links`.
 *
 *  - `POST   /`        — create a link from `{ label }`. Returns full row.
 *  - `GET    /`        — list links (newest first), each with `displayStatus`.
 *  - `GET    /:id`     — link detail + recent files.
 *  - `PATCH  /:id`     — update link status (`active` | `disabled`).
 *  - `DELETE /:id`     — remove the link; received files survive (schema FK
 *                        on `files.receive_link_id` is `ON DELETE SET NULL`).
 *
 * Everything here is gated by `requireAdmin`. The public surface
 * (`/api/public/receive-links/:code`) is its own router.
 *
 * On `displayStatus`: the list endpoint issues one `recordUploadCount` query
 * per link. That's N+1 — acceptable at v1's single-user, small-N scale; if a
 * later milestone surfaces this on dashboards with hundreds of links, swap
 * to a single `GROUP BY` query in `receive-links.ts`.
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
      // Newly created link has zero uploads — short-circuit the count query.
      return c.json({ link: toResponse(link, 0) });
    } catch (err) {
      const message = messageFromAllowedError(err, RECEIVE_LINK_VALIDATION_ERRORS, 'invalid_input');
      if (message === 'invalid_input') logServerError('receive_links.create_failed', err);
      // Thrown shapes: `label_required`, `label_too_long`,
      // `invalid_max_uploads`, `invalid_expires_at`. All user-fixable 400s.
      return c.json({ error: 'invalid_input', message }, 400);
    }
  });

  route.get('/', async (c) => {
    const links = await receiveLinksModule.list();
    const enriched = await Promise.all(
      links.map(async (link) => {
        const count = await receiveLinksModule.recordUploadCount(link.id);
        return toResponse(link, count);
      }),
    );
    return c.json({ links: enriched });
  });

  route.get('/:id', async (c) => {
    const id = c.req.param('id');
    const link = await receiveLinksModule.getById(id);
    if (!link) return c.json({ error: 'not_found' }, 404);
    const filesList = await filesModule.listForReceiveLink(link.id);
    const uploadsSoFar = await receiveLinksModule.recordUploadCount(link.id);
    return c.json({ link: toResponse(link, uploadsSoFar), files: filesList, uploadsSoFar });
  });

  route.patch('/:id', async (c) => {
    const id = c.req.param('id');

    let body: UpdateBody;
    try {
      body = (await c.req.json()) as UpdateBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // Whitelist `status`. Future PATCH fields (label, policy bits) get added
    // here; we don't blindly pass the body through to the module.
    const status = body.status;
    if (status !== 'active' && status !== 'disabled') {
      return c.json({ error: 'invalid_input', message: 'status_required' }, 400);
    }

    let updated;
    try {
      updated = await receiveLinksModule.update(id, { status });
    } catch (err) {
      const message = messageFromAllowedError(err, RECEIVE_LINK_VALIDATION_ERRORS, 'invalid_input');
      if (message === 'invalid_input') logServerError('receive_links.update_failed', err, { id });
      return c.json({ error: 'invalid_input', message }, 400);
    }
    if (!updated) return c.json({ error: 'not_found' }, 404);
    const uploadsSoFar = await receiveLinksModule.recordUploadCount(updated.id);
    return c.json({ link: toResponse(updated, uploadsSoFar) });
  });

  route.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const removed = await receiveLinksModule.remove(id);
    if (!removed) return c.json({ error: 'not_found' }, 404);
    // 204 No Content: the client already has the id, and there's no useful
    // payload after the row is gone. Files previously attached to this link
    // now have `receive_link_id = NULL` (schema FK is `ON DELETE SET NULL`);
    // they remain reachable via `/api/files/:id`.
    return c.body(null, 204);
  });

  return route;
}
