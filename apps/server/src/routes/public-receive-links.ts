import { Hono } from 'hono';

import type { ReceiveLinksModule } from '../links/receive-links.js';
import type { UploadTicketsModule } from '../tickets/upload-tickets.js';

interface UploadTicketBody {
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
  password?: unknown;
}

/**
 * The public-facing receive surface. Unauthenticated; access is gated only
 * by the link's policy (status, expiry, password, quota).
 *
 *  - `GET   /:code`                        — public metadata, intentionally minimal.
 *  - `POST  /:code/upload-tickets`         — mint an upload ticket + presigned PUT.
 *
 * Mounted at `/api/public/receive-links`.
 *
 * Privacy: the GET response NEVER includes the link `id`, `s3_key`, or any
 * other internal identifier. Anything visible here is what an attacker who
 * already has the code could compute themselves; we don't help enumeration.
 */
export function createPublicReceiveLinksRoute(
  receiveLinksModule: ReceiveLinksModule,
  uploadTicketsModule: UploadTicketsModule,
): Hono {
  const route = new Hono();

  route.get('/:code', async (c) => {
    const code = c.req.param('code');
    const link = await receiveLinksModule.getByCode(code);
    if (!link || link.status !== 'active') {
      // We collapse "no such code" and "disabled link" into the same 404
      // shape so a bad actor can't tell the two apart by probing.
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({
      label: link.label,
      passwordRequired: link.passwordHash !== null,
      status: 'ok' as const,
    });
  });

  route.post('/:code/upload-tickets', async (c) => {
    const code = c.req.param('code');

    let body: UploadTicketBody;
    try {
      body = (await c.req.json()) as UploadTicketBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const filename = typeof body.filename === 'string' ? body.filename : '';
    const contentType =
      typeof body.contentType === 'string' && body.contentType.trim().length > 0
        ? body.contentType
        : 'application/octet-stream';
    const size = typeof body.size === 'number' ? body.size : NaN;
    const providedPassword = typeof body.password === 'string' ? body.password : null;

    const outcome = await uploadTicketsModule.createForReceiveLink({
      linkCode: code,
      filename,
      contentType,
      sizeHint: size,
      providedPassword,
    });

    switch (outcome.kind) {
      case 'ok':
        return c.json({
          ticketId: outcome.value.ticketId,
          presignedPutUrl: outcome.value.presignedPutUrl,
          expiresAt: outcome.value.expiresAt.toISOString(),
        });
      case 'link_not_found':
        return c.json({ error: 'not_found' }, 404);
      case 'invalid_input':
        return c.json({ error: 'invalid_input', message: outcome.reason }, 400);
      case 'policy_rejected':
        return c.json({ error: outcome.policy.kind }, 403);
    }
  });

  return route;
}
