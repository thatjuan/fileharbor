import { Hono } from 'hono';

import type { CompletedPart, UploadTicketsModule } from '../tickets/upload-tickets.js';

interface CompletePartBodyEntry {
  partNumber?: unknown;
  etag?: unknown;
}

interface CompleteBody {
  parts?: unknown;
  password?: unknown;
}

interface AbortBody {
  password?: unknown;
}

/**
 * Validate a `parts` payload from a multipart-complete request body. Returns
 * the typed array on success, or `null` if any entry is structurally invalid
 * (non-array, empty, non-integer partNumber, non-string/empty etag). Deeper
 * semantic validation (gaps, dupes, range) is the module's job — the route
 * only guards against a malformed JSON shape.
 */
function parsePartsPayload(value: unknown): CompletedPart[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: CompletedPart[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as CompletePartBodyEntry;
    if (!Number.isInteger(entry.partNumber)) return null;
    const partNumber = entry.partNumber as number;
    if (typeof entry.etag !== 'string' || entry.etag.length === 0) return null;
    out.push({ partNumber, etag: entry.etag });
  }
  return out;
}

/**
 * Public upload-ticket endpoints. Mounted at `/api/public/upload-tickets`.
 *
 *  - `POST  /:ticketId/finalize`                       — single-PUT finalize:
 *    server-side HEAD against the bucket; on success creates the `file` row,
 *    on missing object marks the ticket failed.
 *  - `POST  /:ticketId/upload/multipart/complete`      — multipart complete:
 *    server submits the parts manifest, runs HEAD, records the file row.
 *  - `POST  /:ticketId/upload/multipart/abort`         — multipart abort:
 *    idempotent best-effort cancel. Frontend may call this from a
 *    `keepalive` fetch / sendBeacon on tab close, so the body is optional.
 *  - `GET   /:ticketId/upload/multipart/parts?from=&to=` — fetch additional
 *    presigned PUT-PART URLs in the `[from, to]` inclusive range (≤100 per
 *    call, enforced by the module). Optional `?password=` re-validates the
 *    receive-link policy when the link is password-gated.
 *
 * Unauthenticated by design: the ticket id IS the authorization. It was minted
 * for this specific upload session and only the uploader has it. The password
 * field re-validates link policy where applicable.
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

  route.post('/:ticketId/upload/multipart/complete', async (c) => {
    const ticketId = c.req.param('ticketId');

    let body: CompleteBody;
    try {
      body = (await c.req.json()) as CompleteBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const parts = parsePartsPayload(body.parts);
    if (parts === null) {
      return c.json({ error: 'invalid_input', message: 'invalid_parts' }, 400);
    }
    const providedPassword = typeof body.password === 'string' ? body.password : null;

    const outcome = await uploadTicketsModule.completeMultipart(ticketId, {
      parts,
      providedPassword,
    });

    switch (outcome.kind) {
      case 'completed':
        // Mirror the single-PUT finalize handler's response shape — `status`
        // only, no fileId — so clients have one branch for both protocols.
        return c.json({ status: 'completed' as const });
      case 'failed':
        // `wrong_state` is the race-loser arm (sweep / abort beat us) — surface
        // as 409 so the client can distinguish "session closed" from the
        // recoverable failure reasons that share the `failed` discriminator.
        if (outcome.reason === 'wrong_state') {
          return c.json({ error: 'wrong_state' }, 409);
        }
        return c.json({ status: 'failed' as const, reason: outcome.reason });
      case 'ticket_not_found':
        return c.json({ error: 'not_found' }, 404);
      case 'policy_rejected':
        return c.json({ error: outcome.policy.kind }, 403);
    }
  });

  route.post('/:ticketId/upload/multipart/abort', async (c) => {
    const ticketId = c.req.param('ticketId');

    // Abort body is optional — many callers will fire-and-forget via
    // `fetch({ keepalive: true })` or `navigator.sendBeacon` on tab close,
    // which often elides the JSON body. Parse permissively.
    let providedPassword: string | null = null;
    try {
      const text = await c.req.text();
      if (text.length > 0) {
        const parsed = JSON.parse(text) as AbortBody;
        if (typeof parsed.password === 'string') providedPassword = parsed.password;
      }
    } catch {
      // Malformed JSON is non-fatal — treat as no password and let policy decide.
    }

    const outcome = await uploadTicketsModule.abortMultipart(ticketId, { providedPassword });

    switch (outcome.kind) {
      case 'aborted':
        return c.json({ status: 'aborted' as const });
      case 'already_completed':
        // Idempotent: the upload won the race; bytes are published. Surface
        // as 200 so the keepalive-on-unload callers don't see a network error.
        return c.json({ status: 'already_completed' as const });
      case 'already_aborted':
        return c.json({ status: 'already_aborted' as const });
      case 'ticket_not_found':
        return c.json({ error: 'not_found' }, 404);
    }
  });

  route.get('/:ticketId/upload/multipart/parts', async (c) => {
    const ticketId = c.req.param('ticketId');
    const fromRaw = c.req.query('from');
    const toRaw = c.req.query('to');
    const from = fromRaw !== undefined ? Number(fromRaw) : NaN;
    const to = toRaw !== undefined ? Number(toRaw) : NaN;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
      return c.json({ error: 'invalid_range' }, 400);
    }

    // Password via query param keeps the GET cacheable-shape consistent (no
    // request body) and avoids inventing a new custom header for the public
    // surface. Same trust model as the ticket id: the URL IS the credential.
    const providedPassword = c.req.query('password') ?? null;

    const outcome = await uploadTicketsModule.getMultipartPartUrls(
      ticketId,
      from,
      to,
      providedPassword,
    );

    switch (outcome.kind) {
      case 'ok':
        return c.json({ urls: outcome.value.urls, expiresAt: outcome.value.expiresAt });
      case 'invalid_input':
        // The module's only `invalid_input` reason today is `'invalid_range'`;
        // forward it verbatim so the client gets a stable error code.
        return c.json({ error: outcome.reason }, 400);
      case 'wrong_state':
        return c.json({ error: 'wrong_state' }, 409);
      case 'not_multipart':
        return c.json({ error: 'not_multipart' }, 400);
      case 'ticket_not_found':
        return c.json({ error: 'not_found' }, 404);
      case 'policy_rejected':
        return c.json({ error: outcome.policy.kind }, 403);
    }
  });

  return route;
}
