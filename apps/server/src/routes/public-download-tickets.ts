import { Hono } from 'hono';

import type { DownloadTicketsModule } from '../tickets/download-tickets.js';

interface ConfirmBody {
  outcome?: unknown;
}

/**
 * Public download-ticket confirmation. Mounted at
 * `/api/public/download-tickets`.
 *
 *  - `POST  /:ticketId/confirm`  — best-effort signal that the bytes were
 *    handed off to the bucket. Transitions `pending → completed` and
 *    increments `send_links.download_count`. Idempotent: a second call on a
 *    completed/failed/expired ticket is a no-op (same JSON, no extra writes).
 *
 *    Body (optional): `{ outcome: 'failed' }` to mark the ticket failed
 *    WITHOUT burning a quota slot. The client uses this for the "user clicked
 *    cancel" case; the default is "completed".
 *
 * Unauthenticated: the ticket id IS the authorization. We accept the call
 * with any payload because the worst case is that an attacker who knows a
 * ticket id can move it from pending to completed — same effect as the
 * recipient actually downloading. They've already proven possession of the
 * ticket; they're allowed to acknowledge it.
 *
 * Per #11, the floor for quota burn is the eventual expiry sweep (#10): even
 * if this endpoint is never hit, an unconfirmed pending ticket past its TTL
 * will be expired by the sweep and that expiry burns the slot too. This
 * endpoint is the opportunistic fast path; the sweep is the safety net.
 */
export function createPublicDownloadTicketsRoute(
  downloadTicketsModule: DownloadTicketsModule,
): Hono {
  const route = new Hono();

  route.post('/:ticketId/confirm', async (c) => {
    const ticketId = c.req.param('ticketId');

    // Accept an empty body — many clients will send `Content-Length: 0` with
    // no JSON. Only `outcome === 'failed'` changes behaviour; everything else
    // falls back to "completed".
    let outcome: 'completed' | 'failed' = 'completed';
    try {
      const text = await c.req.text();
      if (text.length > 0) {
        const parsed = JSON.parse(text) as ConfirmBody;
        if (parsed.outcome === 'failed') outcome = 'failed';
      }
    } catch {
      // Malformed JSON is non-fatal — default to "completed".
    }

    const result = await downloadTicketsModule.confirm(ticketId, { outcome });

    switch (result.kind) {
      case 'completed':
        return c.json({ status: 'completed' as const });
      case 'failed':
        return c.json({ status: 'failed' as const });
      case 'already_completed':
        return c.json({ status: 'completed' as const, idempotent: true });
      case 'already_failed':
        return c.json({ status: 'failed' as const, idempotent: true });
      case 'already_expired':
        return c.json({ status: 'expired' as const, idempotent: true });
      case 'ticket_not_found':
        return c.json({ error: 'not_found' }, 404);
    }
  });

  return route;
}
