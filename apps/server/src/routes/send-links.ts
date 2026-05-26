import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import { requireAdmin, type AdminContext } from '../auth/middleware.js';
import type { FilesModule } from '../files/files.js';
import { logServerError, messageFromAllowedError } from '../http/errors.js';
import { evaluateSendLink } from '../links/policy/index.js';
import type { SendLink, SendLinksModule } from '../links/send-links.js';
import type { CompletedPart, UploadTicketsModule } from '../tickets/upload-tickets.js';

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

interface MultipartInitBody {
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
}

interface MultipartCompletePartBodyEntry {
  partNumber?: unknown;
  etag?: unknown;
}

interface MultipartCompleteBody {
  parts?: unknown;
}

interface UpdateBody {
  status?: unknown;
}

const SEND_LINK_VALIDATION_ERRORS = [
  'label_required',
  'label_too_long',
  'invalid_max_downloads',
  'invalid_expires_at',
] as const;

/**
 * Validate a `parts` payload from a multipart-complete request body. Same
 * shape as the public route's validator; duplicated here so the admin
 * surface doesn't import from `public-upload-tickets.ts`.
 */
function parsePartsPayload(value: unknown): CompletedPart[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: CompletedPart[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as MultipartCompletePartBodyEntry;
    if (!Number.isInteger(entry.partNumber)) return null;
    const partNumber = entry.partNumber as number;
    if (typeof entry.etag !== 'string' || entry.etag.length === 0) return null;
    out.push({ partNumber, etag: entry.etag });
  }
  return out;
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
 *  - `POST   /:linkId/files/multipart/init`                   — admin variant
 *                              of the public multipart init. Body
 *                              `{ filename, contentType, size }`.
 *  - `POST   /:linkId/files/multipart/:ticketId/complete`     — admin variant
 *                              of multipart complete. Body `{ parts }`.
 *  - `POST   /:linkId/files/multipart/:ticketId/abort`        — admin variant
 *                              of multipart abort.
 *  - `GET    /:linkId/files/multipart/:ticketId/parts?from=&to=` — admin
 *                              variant of paged PUT-PART URL fetch.
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
      const message = messageFromAllowedError(err, SEND_LINK_VALIDATION_ERRORS, 'invalid_input');
      if (message === 'invalid_input') logServerError('send_links.create_failed', err);
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
      logServerError('send_links.mint_upload_failed', err, { sendLinkId: link.id });
      return c.json({ error: 'mint_failed', message: 'Could not prepare file upload.' }, 500);
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

  // -------------------------------------------------------------------------
  // Admin multipart variants.
  //
  // The `:linkId` URL segment is a UX/grouping hint so admin tooling and logs
  // tie the multipart session back to the visible send-link page. The
  // upload-tickets module identifies the session by `:ticketId` alone — the
  // ticket row carries the link binding internally, so no admin path needs to
  // re-validate the `linkId` against the ticket. Mirrors the existing
  // single-PUT split: `POST /:id/files` mints the ticket but downstream
  // finalize is keyed off `ticketId` over in `public-upload-tickets`.
  //
  // All four inherit the `requireAdmin` middleware from the route's `use`.
  // No password — admin auth IS the policy gate.
  // -------------------------------------------------------------------------

  route.post('/:linkId/files/multipart/init', async (c) => {
    const linkId = c.req.param('linkId');

    let body: MultipartInitBody;
    try {
      body = (await c.req.json()) as MultipartInitBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const filename = typeof body.filename === 'string' ? body.filename : '';
    const contentType =
      typeof body.contentType === 'string' && body.contentType.trim().length > 0
        ? body.contentType
        : 'application/octet-stream';
    const size = typeof body.size === 'number' ? body.size : NaN;

    const outcome = await uploadTicketsModule.initMultipartForSendLink({
      sendLinkId: linkId,
      filename,
      contentType,
      size,
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
        // Admin-bypass means only `disabled` can fire; preserve the
        // discriminator-as-error-code convention used by single-PUT.
        return c.json({ error: outcome.policy.kind }, 403);
    }
  });

  route.post('/:linkId/files/multipart/:ticketId/complete', async (c) => {
    const ticketId = c.req.param('ticketId');

    let body: MultipartCompleteBody;
    try {
      body = (await c.req.json()) as MultipartCompleteBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const parts = parsePartsPayload(body.parts);
    if (parts === null) {
      return c.json({ error: 'invalid_input', message: 'invalid_parts' }, 400);
    }

    const outcome = await uploadTicketsModule.completeMultipart(ticketId, { parts });

    switch (outcome.kind) {
      case 'completed':
        return c.json({ status: 'completed' as const });
      case 'failed':
        if (outcome.reason === 'wrong_state') {
          return c.json({ error: 'wrong_state' }, 409);
        }
        return c.json({ status: 'failed' as const, reason: outcome.reason });
      case 'ticket_not_found':
        return c.json({ error: 'not_found' }, 404);
      case 'policy_rejected':
        // Admin-bypass in the module means only the send-link `disabled`
        // branch fires here in practice; surface uniformly with public.
        return c.json({ error: outcome.policy.kind }, 403);
    }
  });

  route.post('/:linkId/files/multipart/:ticketId/abort', async (c) => {
    const ticketId = c.req.param('ticketId');

    const outcome = await uploadTicketsModule.abortMultipart(ticketId, {});

    switch (outcome.kind) {
      case 'aborted':
        return c.json({ status: 'aborted' as const });
      case 'already_completed':
        return c.json({ status: 'already_completed' as const });
      case 'already_aborted':
        return c.json({ status: 'already_aborted' as const });
      case 'ticket_not_found':
        return c.json({ error: 'not_found' }, 404);
    }
  });

  route.get('/:linkId/files/multipart/:ticketId/parts', async (c) => {
    const ticketId = c.req.param('ticketId');
    const fromRaw = c.req.query('from');
    const toRaw = c.req.query('to');
    const from = fromRaw !== undefined ? Number(fromRaw) : NaN;
    const to = toRaw !== undefined ? Number(toRaw) : NaN;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
      return c.json({ error: 'invalid_range' }, 400);
    }

    const outcome = await uploadTicketsModule.getMultipartPartUrls(ticketId, from, to, null);

    switch (outcome.kind) {
      case 'ok':
        return c.json({ urls: outcome.value.urls, expiresAt: outcome.value.expiresAt });
      case 'invalid_input':
        return c.json({ error: outcome.reason }, 400);
      case 'wrong_state':
        return c.json({ error: 'wrong_state' }, 409);
      case 'not_multipart':
        return c.json({ error: 'not_multipart' }, 400);
      case 'ticket_not_found':
        return c.json({ error: 'not_found' }, 404);
      case 'policy_rejected':
        // Send-side flow does not re-run receive-side policy, but the module's
        // outcome union still includes this kind — handle for exhaustiveness.
        return c.json({ error: outcome.policy.kind }, 403);
    }
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
      const message = messageFromAllowedError(err, SEND_LINK_VALIDATION_ERRORS, 'invalid_input');
      if (message === 'invalid_input') logServerError('send_links.update_failed', err, { id });
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
