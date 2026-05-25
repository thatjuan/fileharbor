import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { FilesModule } from '../files/files.js';
import { evaluateSendLink } from '../links/policy/index.js';
import type { SendLink, SendLinksModule } from '../links/send-links.js';
import type { UploadTicketsModule } from '../tickets/upload-tickets.js';

interface CreateBody {
  label?: unknown;
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
}

/**
 * Display statuses surfaced to the admin UI. Same set the receive side uses,
 * minus `password_required`/`password_wrong` (those are per-attempt verdicts,
 * not dashboard states). `quota_exhausted` here means the recipient download
 * cap was reached — in #8 the column is always null, so this branch is
 * unreachable until #11 wires send-link quotas.
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
 *  - `POST   /`        — atomic-ish create-link-and-mint-ticket. Body:
 *                        `{ label, filename, contentType, size }`. Returns
 *                        `{ link, ticket: { ticketId, presignedPutUrl, expiresAt } }`.
 *                        Admin then PUTs to the URL and calls finalize.
 *  - `GET    /`        — list links (newest first) with `displayStatus`.
 *  - `GET    /:id`     — link detail + bundled files.
 *
 * No PATCH/DELETE this slice — that's #12.
 *
 * On atomicity: SQLite transactions are sync; the presign call inside ticket
 * creation is async, so a single BEGIN/COMMIT spanning both isn't on the
 * table. Pragma: create the link, then mint the ticket; on ticket failure,
 * compensate by deleting the link row. The window where a link exists with
 * no ticket is bounded by the presign + insert duration (sub-second) and the
 * admin UI immediately attempts the PUT — a lingering link with no file is
 * the same state as a finalized failure, which #12 lets the admin clean up.
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
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const contentType =
      typeof body.contentType === 'string' && body.contentType.trim().length > 0
        ? body.contentType
        : 'application/octet-stream';
    const size = typeof body.size === 'number' ? body.size : NaN;

    let link;
    try {
      link = await sendLinksModule.create({ label });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ error: 'invalid_input', message }, 400);
    }

    // Mint the first (and, in #8, only) upload ticket for this link. If mint
    // fails for any reason — bad filename, presign error — compensate by
    // removing the just-created link so the admin can retry from a clean
    // slate. We avoid leaving a "link with zero files" lying around.
    let ticketOutcome;
    try {
      ticketOutcome = await uploadTicketsModule.createForSendLink({
        sendLinkId: link.id,
        filename,
        contentType,
        sizeHint: size,
      });
    } catch (err) {
      await sendLinksModule.remove(link.id);
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ error: 'mint_failed', message }, 500);
    }

    if (ticketOutcome.kind !== 'ok') {
      await sendLinksModule.remove(link.id);
      if (ticketOutcome.kind === 'invalid_input') {
        return c.json({ error: 'invalid_input', message: ticketOutcome.reason }, 400);
      }
      if (ticketOutcome.kind === 'link_not_found') {
        // Theoretically impossible (we just created the link) but the
        // exhaustive switch is cheap insurance.
        return c.json({ error: 'mint_failed', message: 'link_not_found' }, 500);
      }
      return c.json({ error: ticketOutcome.policy.kind }, 403);
    }

    return c.json({
      link: toResponse(link),
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

  return route;
}
