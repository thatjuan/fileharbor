import { Hono } from 'hono';

import type { SecurityConfig } from '../config.js';
import type { ReceiveLinksModule } from '../links/receive-links.js';
import { clientIpFor } from '../security/client-ip.js';
import { enforceRateLimit, type FixedWindowRateLimiter } from '../security/rate-limit.js';
import type { UploadTicketsModule } from '../tickets/upload-tickets.js';

interface UploadTicketBody {
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
  password?: unknown;
}

interface MultipartInitBody {
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
  password?: unknown;
}

/**
 * The public-facing receive surface. Unauthenticated; access is gated only
 * by the link's policy (status, expiry, password, quota).
 *
 *  - `GET   /:code`                              — public metadata, intentionally minimal.
 *  - `POST  /:code/upload-tickets`               — mint a single-PUT upload ticket.
 *  - `POST  /:code/upload/multipart/init`        — mint a multipart upload ticket;
 *    returns the first page of presigned PUT-PART URLs plus a `paginated`
 *    discriminator the client uses to fetch remaining pages via
 *    `GET /api/public/upload-tickets/:ticketId/upload/multipart/parts`.
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
  security: SecurityConfig,
  limiter: FixedWindowRateLimiter,
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
    const ip = clientIpFor(c, security);
    const limited = enforceRateLimit(c, security, limiter, [
      { key: `public-link:${ip}:${code}`, limit: security.rateLimit.publicLink },
      { key: `public-ticket:${ip}`, limit: security.rateLimit.publicTicket },
    ]);
    if (limited) return limited;

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

  route.post('/:code/upload/multipart/init', async (c) => {
    const code = c.req.param('code');
    const ip = clientIpFor(c, security);
    const limited = enforceRateLimit(c, security, limiter, [
      { key: `public-link:${ip}:${code}`, limit: security.rateLimit.publicLink },
      { key: `public-ticket:${ip}`, limit: security.rateLimit.publicTicket },
    ]);
    if (limited) return limited;

    let body: MultipartInitBody;
    try {
      body = (await c.req.json()) as MultipartInitBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // Mirror the single-PUT body parser at lines above — defaults and types
    // stay in lockstep so a frontend that flips between paths sees one shape.
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const contentType =
      typeof body.contentType === 'string' && body.contentType.trim().length > 0
        ? body.contentType
        : 'application/octet-stream';
    const size = typeof body.size === 'number' ? body.size : NaN;
    const providedPassword = typeof body.password === 'string' ? body.password : null;

    const outcome = await uploadTicketsModule.initMultipart({
      linkCode: code,
      filename,
      contentType,
      size,
      providedPassword,
    });

    switch (outcome.kind) {
      case 'ok':
        return c.json({
          ticketId: outcome.value.ticketId,
          uploadId: outcome.value.uploadId,
          partSize: outcome.value.partSize,
          expectedParts: outcome.value.expectedParts,
          initialUrls: outcome.value.initialUrls,
          paginated: outcome.value.paginated,
          expiresAt: outcome.value.expiresAt,
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
