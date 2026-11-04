import { Hono } from 'hono';

import type { SecurityConfig } from '../config.js';
import { clientIpFor } from '../security/client-ip.js';
import { enforceRateLimit, type FixedWindowRateLimiter } from '../security/rate-limit.js';
import type { DownloadTicketsModule } from '../tickets/download-tickets.js';

interface ConfirmBody {
  outcome?: unknown;
}

/**
 * Public download-ticket confirmation. Mounted at
 * `/api/public/download-tickets`.
 *
 *  - `POST  /:ticketId/confirm`  — best-effort signal that the bytes were
 *    handed off to the bucket. Transitions `pending → completed`. Idempotent:
 *    a second call on a completed/failed/expired ticket is a no-op (same
 *    JSON, no extra writes).
 *
 *    Body (optional): `{ outcome: 'failed' }` to mark the ticket failed. The
 *    client uses this for the "user clicked cancel" case; the default is
 *    "completed".
 *
 * Neither outcome touches quota: `download-tickets.createForSendLink` burns
 * the slot at mint, because the server can't verify a client-asserted
 * failure. This endpoint only records the outcome for status display.
 *
 * Unauthenticated: the ticket id IS the authorization. We accept the call
 * with any payload because the worst case is that an attacker who knows a
 * ticket id can relabel a pending ticket's outcome.
 */
export function createPublicDownloadTicketsRoute(
  downloadTicketsModule: DownloadTicketsModule,
  security: SecurityConfig,
  limiter: FixedWindowRateLimiter,
): Hono {
  const route = new Hono();

  route.post('/:ticketId/confirm', async (c) => {
    const ticketId = c.req.param('ticketId');
    const ip = clientIpFor(c, security);
    const limited = enforceRateLimit(c, security, limiter, [
      { key: `public-confirm:${ip}`, limit: security.rateLimit.publicConfirm },
      { key: `public-confirm:${ip}:${ticketId}`, limit: security.rateLimit.publicConfirm },
    ]);
    if (limited) return limited;

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
