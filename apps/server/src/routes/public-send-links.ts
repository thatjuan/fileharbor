import { Hono, type Context } from 'hono';

import type { SecurityConfig } from '../config.js';
import type { FilesModule } from '../files/files.js';
import { isPlausibleCode, normalizeCode } from '../links/code-generator.js';
import { resolvePasswordCheck } from '../links/policy/password-check.js';
import type { SendLink, SendLinksModule } from '../links/send-links.js';
import { clientIpFor } from '../security/client-ip.js';
import {
  enforceRateLimit,
  rejectIfRateLimitReached,
  type RateLimiters,
} from '../security/rate-limit.js';
import type { DownloadTicketsModule } from '../tickets/download-tickets.js';

interface DownloadTicketBody {
  fileId?: unknown;
  password?: unknown;
}

interface FilesBody {
  password?: unknown;
}

/** Password failures on one code from every address combined. */
function codePasswordFailureKey(code: string): string {
  return `public-password-fail:${normalizeCode(code)}`;
}

/**
 * Admission for the password-checking endpoints (`/files`, `/download-tickets`):
 * consumes the per-IP bucket first, then the per-IP-per-code bucket, on every
 * request, then refuses a code whose per-code password-failure budget is spent.
 * Shared so both endpoints keep one rate-limit pattern. Keys carry the
 * normalized code so case and alias variants share a bucket.
 */
function enforceSendLinkAdmission(
  c: Context,
  code: string,
  security: SecurityConfig,
  limiters: RateLimiters,
): Response | null {
  const ip = clientIpFor(c, security);
  const limited = enforceRateLimit(c, security, limiters.public, [
    { key: `public-ticket:${ip}`, limit: security.rateLimit.publicTicket },
    { key: `public-link:${ip}:${normalizeCode(code)}`, limit: security.rateLimit.publicLink },
  ]);
  if (limited) return limited;

  return rejectIfRateLimitReached(c, security, limiters.auth, [
    { key: codePasswordFailureKey(code), limit: security.rateLimit.publicLink },
  ]);
}

/**
 * Counts a missing or wrong password against the per-code budget, which stops
 * an attacker who rotates addresses (each address is already capped by the
 * per-IP-per-code bucket). The cost: while an attack runs, the real recipient
 * is locked out of the link too. That is accepted because the lockout ends
 * when the window does.
 */
function recordPasswordFailure(
  c: Context,
  code: string,
  security: SecurityConfig,
  limiters: RateLimiters,
): Response | null {
  return enforceRateLimit(c, security, limiters.auth, [
    { key: codePasswordFailureKey(code), limit: security.rateLimit.publicLink },
  ]);
}

function isExpired(link: SendLink, now: number): boolean {
  return link.expiresAt !== null && link.expiresAt <= now;
}

/**
 * The public-facing send surface. Unauthenticated; access is gated only by
 * the link's policy (status / expiry / password / quota).
 *
 *  - `GET   /:code`                          — public metadata, plus the file
 *    list when the link has no password and hasn't expired.
 *  - `POST  /:code/files`                    — the file list of a password
 *    link, after the password checks out.
 *  - `POST  /:code/download-tickets`         — mint a download ticket + presigned GET.
 *
 * Mounted at `/api/public/send-links`. Privacy: responses NEVER include the
 * send link's `id` or any other internal identifier; only the file ids are
 * returned (because the recipient needs them to request a download). Every
 * endpoint answers a disabled link with the same 404 as a missing code, so a
 * bad actor can't tell the two apart by probing. A code that cannot exist
 * (see `isPlausibleCode`) gets that 404 before any rate limiter sees it, and
 * the GET is throttled per IP so it is no use as an existence oracle.
 *
 * Disclosure rules for the GET:
 *   - Password links return `files: []` plus `fileCount`; the names come from
 *     `POST /:code/files` once the password is verified.
 *   - Expired links return `status: 'expired'` and `files: []`, so the page
 *     can say why without listing what the link used to hold.
 *   - `quota_exhausted` links still answer `status: 'ok'` with their files;
 *     the mint endpoint returns the specific reason.
 *
 * Empty file list is otherwise a legitimate state — the link is created the
 * moment the admin POSTs `/api/send-links`, before any file is added. The
 * frontend renders "no files yet" cleanly.
 */
export function createPublicSendLinksRoute(
  sendLinksModule: SendLinksModule,
  filesModule: FilesModule,
  downloadTicketsModule: DownloadTicketsModule,
  security: SecurityConfig,
  limiters: RateLimiters,
): Hono {
  const route = new Hono();

  /** The recipient-facing shape of a link's files. */
  const listPublicFiles = async (linkId: string) =>
    (await filesModule.listForSendLink(linkId)).map((f) => ({
      id: f.id,
      filename: f.filename,
      size: f.size,
      contentType: f.contentType,
    }));

  route.get('/:code', async (c) => {
    const code = c.req.param('code');
    if (!isPlausibleCode(code)) return c.json({ error: 'not_found' }, 404);
    const limited = enforceRateLimit(c, security, limiters.public, [
      {
        key: `public-lookup:${clientIpFor(c, security)}`,
        limit: security.rateLimit.publicLookup,
      },
    ]);
    if (limited) return limited;

    const link = await sendLinksModule.getByCode(code);
    if (!link || link.status !== 'active') {
      return c.json({ error: 'not_found' }, 404);
    }

    // Remaining downloads is only meaningful if the admin set a cap. We expose
    // it (clamped to 0) so the public page can render "N downloads left". We
    // deliberately don't expose `downloadCount` alone — the absolute counter
    // leaks how often the link has been hit, which the recipient doesn't need.
    const remainingDownloads =
      link.maxDownloads !== null ? Math.max(0, link.maxDownloads - link.downloadCount) : null;
    const base = {
      label: link.label,
      passwordRequired: link.passwordHash !== null,
      maxDownloads: link.maxDownloads,
      remainingDownloads,
      expiresAt: link.expiresAt,
    };

    if (isExpired(link, Math.floor(Date.now() / 1000))) {
      return c.json({ ...base, status: 'expired' as const, files: [] });
    }
    if (link.passwordHash !== null) {
      const fileCount = await sendLinksModule.recordFileCount(link.id);
      return c.json({ ...base, status: 'ok' as const, fileCount, files: [] });
    }
    return c.json({ ...base, status: 'ok' as const, files: await listPublicFiles(link.id) });
  });

  route.post('/:code/files', async (c) => {
    const code = c.req.param('code');
    if (!isPlausibleCode(code)) return c.json({ error: 'not_found' }, 404);
    const limited = enforceSendLinkAdmission(c, code, security, limiters);
    if (limited) return limited;

    let body: FilesBody;
    try {
      body = (await c.req.json()) as FilesBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const providedPassword = typeof body.password === 'string' ? body.password : null;

    const link = await sendLinksModule.getByCode(code);
    if (!link || link.status !== 'active') {
      return c.json({ error: 'not_found' }, 404);
    }

    const passwordCheck = await resolvePasswordCheck(link.passwordHash, providedPassword);
    switch (passwordCheck.kind) {
      case 'missing':
      case 'wrong': {
        const passwordLimited = recordPasswordFailure(c, code, security, limiters);
        if (passwordLimited) return passwordLimited;
        const error = passwordCheck.kind === 'missing' ? 'password_required' : 'password_wrong';
        return c.json({ error }, 403);
      }
      case 'not_required':
      case 'correct':
        break;
    }

    if (isExpired(link, Math.floor(Date.now() / 1000))) {
      return c.json({ files: [] });
    }
    return c.json({ files: await listPublicFiles(link.id) });
  });

  route.post('/:code/download-tickets', async (c) => {
    const code = c.req.param('code');
    if (!isPlausibleCode(code)) return c.json({ error: 'not_found' }, 404);
    const limited = enforceSendLinkAdmission(c, code, security, limiters);
    if (limited) return limited;

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
      case 'policy_rejected': {
        // A disabled link must look exactly like a missing one.
        if (outcome.policy.kind === 'disabled') {
          return c.json({ error: 'not_found' }, 404);
        }
        if (
          outcome.policy.kind === 'password_required' ||
          outcome.policy.kind === 'password_wrong'
        ) {
          const passwordLimited = recordPasswordFailure(c, code, security, limiters);
          if (passwordLimited) return passwordLimited;
        }
        return c.json({ error: outcome.policy.kind }, 403);
      }
    }
  });

  return route;
}
