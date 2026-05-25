import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { FilesModule } from '../files/files.js';
import { evaluateSendLink } from '../links/policy/index.js';
import type { SendLink, SendLinksModule } from '../links/send-links.js';
import type { UploadTicketsModule } from '../tickets/upload-tickets.js';

interface CreateBody {
  label?: unknown;
  password?: unknown;
  maxDownloads?: unknown;
  expiresAt?: unknown;
}

interface AddFileBody {
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
}

interface UpdateBody {
  status?: unknown;
}

/**
 * Display statuses surfaced to the admin UI. Same set the receive side uses,
 * minus `password_required`/`password_wrong` (those are per-attempt verdicts,
 * not dashboard states).
 */
type DisplayStatus = 'active' | 'expired' | 'quota_exhausted' | 'disabled';

interface SendLinkResponse {
  id: string;
  code: string;
  label: string;
  passwordProtected: boolean;
  maxDownloads: number | null;
  downloadCount: number;
  expiresAt: number | null;
  status: 'active' | 'disabled';
  displayStatus: DisplayStatus;
  createdAt: number;
}

function computeDisplayStatus(link: SendLink, downloadsSoFar: number): DisplayStatus {
  const verdict = evaluateSendLink(link, Math.floor(Date.now() / 1000), downloadsSoFar, {
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
    // `not_required` rules these out for the dashboard display; fall through
    // to `active` for type completeness.
    case 'password_required':
    case 'password_wrong':
      return 'active';
  }
}

function toResponse(link: SendLink): SendLinkResponse {
  return {
    id: link.id,
    code: link.code,
    label: link.label,
    passwordProtected: link.passwordHash !== null,
    maxDownloads: link.maxDownloads,
    downloadCount: link.downloadCount,
    expiresAt: link.expiresAt,
    status: link.status,
    displayStatus: computeDisplayStatus(link, link.downloadCount),
    createdAt: link.createdAt,
  };
}

/**
 * Admin (authed) routes over `send_links`. Mounted at `/api/send-links`.
 *
 *  - `POST   /`             — create a link with `{ label, password?,
 *                              maxDownloads?, expiresAt? }`. Returns the link
 *                              row. NO file is attached; the admin then calls
 *                              `POST /:id/files` once per file to bundle.
 *  - `POST   /:id/files`    — mint an upload-ticket for an additional file
 *                              bound to this send link. Body:
 *                              `{ filename, contentType, size }`. Returns
 *                              `{ ticket: { ticketId, presignedPutUrl,
 *                              expiresAt } }`. Admin PUTs to the URL and calls
 *                              the public finalize endpoint.
 *  - `GET    /`             — list links (newest first) with `displayStatus`.
 *  - `GET    /:id`          — link detail + bundled files.
 *  - `PATCH  /:id`          — update link status (`active` | `disabled`).
 *                              Mirrors the receive-side PATCH shape.
 *  - `DELETE /:id`          — remove the link. Bundled files survive
 *                              (`files.send_link_id` → SET NULL); outstanding
 *                              upload + download tickets are cascade-deleted
 *                              by the schema. S3 objects are NOT touched.
 *
 * The split (#11) replaces the old atomic "create-link-and-mint-ticket" route.
 * Rationale: a send link is now a bundle of multiple files, not 1:1 with a
 * file. Two endpoints model the lifecycle honestly — the link is the
 * container; files come and go.
 *
 * On atomicity: the previous route compensated by deleting the link if the
 * first ticket mint failed. With the split, the link is intentionally allowed
 * to exist empty — the public page already renders empty bundles cleanly (#8).
 * #12's DELETE lets the admin clean up the link if a creation flow goes
 * sideways without losing the files that did land.
 */
export function createSendLinksRoute(
  authModule: AuthModule,
  sendLinksModule: SendLinksModule,
  uploadTicketsModule: UploadTicketsModule,
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

    // Each policy field is independently optional. Mirrors the receive side's
    // POST body shape.
    const password = typeof body.password === 'string' ? body.password : null;
    const maxDownloads = typeof body.maxDownloads === 'number' ? body.maxDownloads : null;
    const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : null;

    try {
      const link = await sendLinksModule.create({ label, password, maxDownloads, expiresAt });
      return c.json({ link: toResponse(link) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      // Thrown shapes: `label_required`, `label_too_long`,
      // `invalid_max_downloads`, `invalid_expires_at`. All user-fixable 400s.
      return c.json({ error: 'invalid_input', message }, 400);
    }
  });

  route.post('/:id/files', async (c) => {
    const id = c.req.param('id');

    let body: AddFileBody;
    try {
      body = (await c.req.json()) as AddFileBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const contentType =
      typeof body.contentType === 'string' && body.contentType.trim().length > 0
        ? body.contentType
        : 'application/octet-stream';
    const size = typeof body.size === 'number' ? body.size : NaN;

    // Pre-flight: confirm the link exists so we can return a clean 404 rather
    // than letting the ticket module's `link_not_found` outcome carry it.
    const link = await sendLinksModule.getById(id);
    if (!link) return c.json({ error: 'not_found' }, 404);

    let ticketOutcome;
    try {
      ticketOutcome = await uploadTicketsModule.createForSendLink({
        sendLinkId: link.id,
        filename,
        contentType,
        sizeHint: size,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ error: 'mint_failed', message }, 500);
    }

    if (ticketOutcome.kind !== 'ok') {
      if (ticketOutcome.kind === 'invalid_input') {
        return c.json({ error: 'invalid_input', message: ticketOutcome.reason }, 400);
      }
      if (ticketOutcome.kind === 'link_not_found') {
        return c.json({ error: 'not_found' }, 404);
      }
      // Admin-bypass in `createForSendLink` means only `disabled` can land
      // here — but we serialize the full policy code regardless for forward-
      // compat with any future admin-side gating.
      return c.json({ error: ticketOutcome.policy.kind }, 403);
    }

    return c.json({
      ticket: {
        ticketId: ticketOutcome.value.ticketId,
        presignedPutUrl: ticketOutcome.value.presignedPutUrl,
        expiresAt: ticketOutcome.value.expiresAt.toISOString(),
      },
    });
  });

  route.get('/', async (c) => {
    const links = await sendLinksModule.list();
    // `downloadCount` is on the row; no N+1 here (unlike receive list, which
    // counts files per link). One query, simple map.
    return c.json({ links: links.map(toResponse) });
  });

  route.get('/:id', async (c) => {
    const id = c.req.param('id');
    const link = await sendLinksModule.getById(id);
    if (!link) return c.json({ error: 'not_found' }, 404);
    const filesList = await filesModule.listForSendLink(link.id);
    return c.json({ link: toResponse(link), files: filesList });
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
    // here; we don't blindly pass the body through to the module. Mirrors
    // the receive-side PATCH shape exactly.
    const status = body.status;
    if (status !== 'active' && status !== 'disabled') {
      return c.json({ error: 'invalid_input', message: 'status_required' }, 400);
    }

    let updated;
    try {
      updated = await sendLinksModule.update(id, { status });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ error: 'invalid_input', message }, 400);
    }
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json({ link: toResponse(updated) });
  });

  route.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const removed = await sendLinksModule.remove(id);
    if (!removed) return c.json({ error: 'not_found' }, 404);
    // 204 No Content. Cascade behaviour (per schema FKs):
    //   - `upload_tickets.send_link_id`   → CASCADE
    //   - `download_tickets.send_link_id` → CASCADE
    //   - `files.send_link_id`            → SET NULL
    // S3 objects are intentionally untouched — the bytes remain in the bucket
    // and are still reachable via `/api/files/:id`.
    return c.body(null, 204);
  });

  return route;
}
