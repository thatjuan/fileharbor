import { Hono } from 'hono';

import type { FilesModule } from '../files/files.js';
import type { SendLinksModule } from '../links/send-links.js';
import type { DownloadTicketsModule } from '../tickets/download-tickets.js';

interface DownloadTicketBody {
  fileId?: unknown;
  password?: unknown;
}

/**
 * The public-facing send surface. Unauthenticated; access is gated only by
 * the link's policy (status / expiry / password / quota).
 *
 *  - `GET   /:code`                          — public metadata + bundled files.
 *  - `POST  /:code/download-tickets`         — mint a download ticket + presigned GET.
 *
 * Mounted at `/api/public/send-links`. Privacy: the GET response NEVER
 * includes the send link's `id` or any other internal identifier; only the
 * file ids are returned (because the recipient needs them to request a
 * download). 404 collapses "no such code" and "disabled link" into one shape
 * so a bad actor can't tell the two apart by probing.
 *
 * Empty file list is a legitimate state — the link is created the moment the
 * admin POSTs `/api/send-links`, before any file is added. The frontend
 * renders "no files yet" cleanly.
 *
 * `expired` and `quota_exhausted` links still answer GET with `status: 'ok'`
 * and let the mint endpoint return the specific reason — that's where the
 * recipient finds out what went wrong. Only `status !== 'active'` (the
 * admin-toggled disabled state) collapses to 404 on the GET, because that's
 * the only verdict where the link should look like it never existed.
 */
export function createPublicSendLinksRoute(
  sendLinksModule: SendLinksModule,
  filesModule: FilesModule,
  downloadTicketsModule: DownloadTicketsModule,
): Hono {
  const route = new Hono();

  route.get('/:code', async (c) => {
    const code = c.req.param('code');
    const link = await sendLinksModule.getByCode(code);
    if (!link || link.status !== 'active') {
      return c.json({ error: 'not_found' }, 404);
    }
    const filesList = await filesModule.listForSendLink(link.id);

    // Remaining downloads is only meaningful if the admin set a cap. We expose
    // it (clamped to 0) so the public page can render "N downloads left". We
    // deliberately don't expose `downloadCount` alone — the absolute counter
    // leaks how often the link has been hit, which the recipient doesn't need.
    const remainingDownloads =
      link.maxDownloads !== null ? Math.max(0, link.maxDownloads - link.downloadCount) : null;

    return c.json({
      label: link.label,
      passwordRequired: link.passwordHash !== null,
      status: 'ok' as const,
      maxDownloads: link.maxDownloads,
      remainingDownloads,
      expiresAt: link.expiresAt,
      files: filesList.map((f) => ({
        id: f.id,
        filename: f.filename,
        size: f.size,
        contentType: f.contentType,
      })),
    });
  });

  route.post('/:code/download-tickets', async (c) => {
    const code = c.req.param('code');

    let body: DownloadTicketBody;
    try {
      body = (await c.req.json()) as DownloadTicketBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const fileId = typeof body.fileId === 'string' ? body.fileId : '';
    if (fileId.length === 0) {
      return c.json({ error: 'invalid_input', message: 'file_id_required' }, 400);
    }
    const providedPassword = typeof body.password === 'string' ? body.password : null;

    const outcome = await downloadTicketsModule.createForSendLink({
      linkCode: code,
      fileId,
      providedPassword,
    });

    switch (outcome.kind) {
      case 'ok':
        return c.json({
          ticketId: outcome.value.ticketId,
          presignedGetUrl: outcome.value.presignedGetUrl,
          expiresAt: outcome.value.expiresAt.toISOString(),
        });
      case 'link_not_found':
      case 'file_not_found':
        // Collapse both into the same opaque 404 to avoid leaking which axis
        // the request failed on (anti-enumeration parity with the GET).
        return c.json({ error: 'not_found' }, 404);
      case 'policy_rejected':
        return c.json({ error: outcome.policy.kind }, 403);
    }
  });

  return route;
}
