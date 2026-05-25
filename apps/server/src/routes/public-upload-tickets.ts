import { Hono } from 'hono';

import type { UploadTicketsModule } from '../tickets/upload-tickets.js';

/**
 * Public finalize endpoint. Mounted at `/api/public/upload-tickets`.
 *
 *  - `POST  /:ticketId/finalize`  — server-side HEAD against the bucket;
 *    on success creates the `file` row, on missing object marks the ticket
 *    failed.
 *
 * Unauthenticated by design: the ticket id IS the authorization. It was minted
 * for this specific upload session and only the uploader has it. (Once #6
 * adds passwords, the request body's `password` field re-validates here too.)
 */
export function createPublicUploadTicketsRoute(uploadTicketsModule: UploadTicketsModule): Hono {
  const route = new Hono();

  route.post('/:ticketId/finalize', async (c) => {
    const ticketId = c.req.param('ticketId');

    // Accept an empty body — many clients will send `Content-Length: 0` with
    // no JSON. We try to parse `password` if a body is provided (forward-compat
    // for #6), but absence is fine.
    let providedPassword: string | null = null;
    try {
      const text = await c.req.text();
      if (text.length > 0) {
        const parsed = JSON.parse(text) as { password?: unknown };
        if (typeof parsed.password === 'string') providedPassword = parsed.password;
      }
    } catch {
      // Malformed JSON is non-fatal — treat as no password and let policy decide.
    }

    const outcome = await uploadTicketsModule.finalize(ticketId, { providedPassword });

    switch (outcome.kind) {
      case 'completed':
        return c.json({ status: 'completed' as const });
      case 'failed':
        return c.json({ status: 'failed' as const, reason: outcome.reason });
      case 'ticket_not_found':
        return c.json({ error: 'not_found' }, 404);
      case 'policy_rejected':
        return c.json({ error: outcome.policy.kind }, 403);
    }
  });

  return route;
}
