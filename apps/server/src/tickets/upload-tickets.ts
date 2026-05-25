import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { uploadTickets } from '../db/schema.js';
import type { FilesModule } from '../files/files.js';
import {
  evaluateReceiveLink,
  type ReceiveLinkPolicyResult,
} from '../links/policy/index.js';
import { resolvePasswordCheck } from '../links/policy/password-check.js';
import type { ReceiveLink, ReceiveLinksModule } from '../links/receive-links.js';
import type { SendLink, SendLinksModule } from '../links/send-links.js';
import type { StorageProvider } from '../storage/index.js';

/**
 * Upload-ticket lifecycle. The primitive is the same for both directions —
 * what differs is which link the ticket points at and what bucket-key prefix
 * is minted. PRD: "the same ticket primitive serves both directions — the
 * ticket carries an 'intent' of which link it belongs to."
 *
 *   - `createForReceiveLink` — caller is the external uploader. Policy
 *     (status/expiry/quota/password) is checked before minting. Bucket key
 *     prefix is `receive/<link_id>/<ticket_id>/<filename>`.
 *
 *   - `createForSendLink` — caller is the admin (auth checked upstream at
 *     the route). Send-link policy for #8 only excludes `disabled` links;
 *     password/quota/expiry land in #11. Bucket key prefix is
 *     `send/<link_id>/<ticket_id>/<filename>`.
 *
 *   - `finalize` — intent-agnostic. Calls `storage.headObject`; on success
 *     creates a `file` record bound to the right link (whichever FK was
 *     non-null on the ticket), marks the ticket completed. Re-finalize on
 *     completed is idempotent; on failed it's a retry path. Re-validates the
 *     link's policy when re-finalising to guard against an attacker holding a
 *     pre-disable ticket.
 *
 * The bucket key includes the `<filename>` segment for human-legible logs in
 * the bucket browser but it is sanitised first — slashes, control chars, and
 * NULs are stripped, and a fallback name is used if the result is empty. The
 * DB row is the source of truth for the displayed filename; the key is opaque.
 */

export type UploadTicketStatus = 'pending' | 'completed' | 'failed' | 'expired';

export interface UploadTicket {
  id: string;
  intent: 'receive' | 'send';
  receiveLinkId: string | null;
  sendLinkId: string | null;
  s3Key: string;
  filename: string;
  contentType: string;
  sizeHint: number | null;
  status: UploadTicketStatus;
  createdAt: number;
  completedAt: number | null;
}

export interface CreateForReceiveLinkInput {
  linkCode: string;
  filename: string;
  contentType: string;
  sizeHint: number;
  providedPassword?: string | null;
}

export interface CreateForReceiveLinkResult {
  ticketId: string;
  presignedPutUrl: string;
  expiresAt: Date;
}

export type CreateForReceiveLinkOutcome =
  | { kind: 'ok'; value: CreateForReceiveLinkResult }
  | { kind: 'link_not_found' }
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult }
  | { kind: 'invalid_input'; reason: string };

/**
 * Send-side: caller already has the link id (it minted the link a moment ago
 * via the admin route), so we accept the id rather than the code. The admin
 * route is `requireAdmin`-gated, so password isn't applicable here in #8 —
 * password / quota on send links is #11 and lives on the *recipient* surface,
 * not the admin upload surface.
 */
export interface CreateForSendLinkInput {
  sendLinkId: string;
  filename: string;
  contentType: string;
  sizeHint: number;
}

/**
 * Admin upload to a send link bypasses recipient policy (password / quota /
 * expiry) — the admin owns the link and isn't downloading. The only verdict
 * that can fire here is the admin's own `disabled` toggle. Typing this branch
 * as the literal `{ kind: 'disabled' }` tells the truth at the type level so
 * callers don't have to handle policy branches that can never occur.
 */
export type CreateForSendLinkOutcome =
  | { kind: 'ok'; value: CreateForReceiveLinkResult }
  | { kind: 'link_not_found' }
  | { kind: 'policy_rejected'; policy: { kind: 'disabled' } }
  | { kind: 'invalid_input'; reason: string };

export type FinalizeOutcome =
  | { kind: 'completed'; fileId: string }
  | { kind: 'failed'; reason: 'object_not_found' }
  | { kind: 'ticket_not_found' }
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult };

export interface UploadTicketsModule {
  createForReceiveLink(input: CreateForReceiveLinkInput): Promise<CreateForReceiveLinkOutcome>;
  createForSendLink(input: CreateForSendLinkInput): Promise<CreateForSendLinkOutcome>;
  finalize(
    ticketId: string,
    input?: { providedPassword?: string | null },
  ): Promise<FinalizeOutcome>;
}

/** Shared validation for both intents — same checks, same error strings. */
function validateUploadInput(input: {
  filename: string;
  contentType: string;
  sizeHint: number;
}): { ok: true; filename: string; contentType: string } | { ok: false; reason: string } {
  const filename = sanitizeFilename(input.filename);
  if (filename.length === 0) {
    return { ok: false, reason: 'filename_required' };
  }
  const contentType = input.contentType.trim();
  if (contentType.length === 0) {
    return { ok: false, reason: 'content_type_required' };
  }
  if (!Number.isInteger(input.sizeHint) || input.sizeHint < 0) {
    return { ok: false, reason: 'invalid_size' };
  }
  return { ok: true, filename, contentType };
}

export function createUploadTicketsModule(
  db: Db,
  storage: StorageProvider,
  receiveLinksModule: ReceiveLinksModule,
  sendLinksModule: SendLinksModule,
  filesModule: FilesModule,
): UploadTicketsModule {
  /**
   * Shared private helper: presign + persist a pending ticket row. Both
   * `createForReceiveLink` and `createForSendLink` funnel through here once
   * they've resolved policy on their respective link types. Keeping the
   * insert in one place means the row shape stays in lockstep across intents.
   */
  async function mintTicket(args: {
    intent: 'receive' | 'send';
    keyPrefix: 'receive' | 'send';
    linkId: string;
    filename: string;
    contentType: string;
    sizeHint: number;
  }): Promise<CreateForReceiveLinkResult> {
    const ticketId = randomUUID();
    const s3Key = `${args.keyPrefix}/${args.linkId}/${ticketId}/${args.filename}`;

    const presigned = await storage.presignPut(s3Key, {
      contentType: args.contentType,
      contentLength: args.sizeHint,
    });

    const now = Math.floor(Date.now() / 1000);
    db.insert(uploadTickets)
      .values({
        id: ticketId,
        intent: args.intent,
        receiveLinkId: args.intent === 'receive' ? args.linkId : null,
        sendLinkId: args.intent === 'send' ? args.linkId : null,
        s3Key,
        filename: args.filename,
        contentType: args.contentType,
        sizeHint: args.sizeHint,
        status: 'pending',
        createdAt: now,
        completedAt: null,
      })
      .run();

    return {
      ticketId,
      presignedPutUrl: presigned.url,
      expiresAt: presigned.expiresAt,
    };
  }

  return {
    async createForReceiveLink(input) {
      const validated = validateUploadInput(input);
      if (!validated.ok) return { kind: 'invalid_input', reason: validated.reason };

      const link = await receiveLinksModule.getByCode(input.linkCode);
      if (!link) return { kind: 'link_not_found' };

      const now = Math.floor(Date.now() / 1000);
      const uploadsSoFar = await receiveLinksModule.recordUploadCount(link.id);
      const passwordCheck = await resolvePasswordCheck(
        link.passwordHash,
        input.providedPassword ?? null,
      );
      const policy = evaluateReceiveLink(link, now, uploadsSoFar, passwordCheck);
      if (policy.kind !== 'ok') {
        return { kind: 'policy_rejected', policy };
      }

      const value = await mintTicket({
        intent: 'receive',
        keyPrefix: 'receive',
        linkId: link.id,
        filename: validated.filename,
        contentType: validated.contentType,
        sizeHint: input.sizeHint,
      });
      return { kind: 'ok', value };
    },

    async createForSendLink(input) {
      const validated = validateUploadInput(input);
      if (!validated.ok) return { kind: 'invalid_input', reason: validated.reason };

      const link = await sendLinksModule.getById(input.sendLinkId);
      if (!link) return { kind: 'link_not_found' };

      // Admin upload flow. `password` / `max_downloads` / `expires_at` are
      // recipient-side policy: an admin adding a file to a link they own is
      // not "downloading", so those branches don't apply here. We do still
      // honour `status === 'disabled'` — the admin's own toggle (#12) should
      // also gate the admin's own add-file path so the dashboard doesn't show
      // "I disabled this" while still letting the admin grow it.
      if (link.status === 'disabled') {
        return { kind: 'policy_rejected', policy: { kind: 'disabled' } };
      }

      const value = await mintTicket({
        intent: 'send',
        keyPrefix: 'send',
        linkId: link.id,
        filename: validated.filename,
        contentType: validated.contentType,
        sizeHint: input.sizeHint,
      });
      return { kind: 'ok', value };
    },

    async finalize(ticketId, input) {
      const ticketRow = db.select().from(uploadTickets).where(eq(uploadTickets.id, ticketId)).get();
      if (!ticketRow) return { kind: 'ticket_not_found' };

      // Idempotency on completed: if a finalize call previously created the
      // file row and marked the ticket completed, return the same answer with
      // no extra work. The lookup path differs by intent — receive tickets
      // resolve via `listForReceiveLink`, send tickets via `listForSendLink`.
      //
      // We do NOT re-run policy on this branch: the file already exists; the
      // bytes have already landed; refusing to acknowledge that because the
      // link has since been disabled or expired would be a lie. The dashboard
      // can still delete the file via its own surface.
      if (ticketRow.status === 'completed') {
        const list =
          ticketRow.intent === 'receive'
            ? await filesModule.listForReceiveLink(ticketRow.receiveLinkId ?? '')
            : await filesModule.listForSendLink(ticketRow.sendLinkId ?? '');
        const existing = list.find((f) => f.s3Key === ticketRow.s3Key);
        // Defensive: a completed ticket should always have a corresponding
        // file row, but if state got out of sync we still return completed
        // with a synthetic id rather than 500. The dashboard will only
        // surface files that actually exist.
        return { kind: 'completed', fileId: existing?.id ?? '' };
      }

      // For `failed` we allow re-finalize (uploader retries the PUT, then
      // re-finalizes). For `expired` we don't — the presigned URL is gone.
      if (ticketRow.status === 'expired') {
        return { kind: 'failed', reason: 'object_not_found' };
      }

      // Re-validate the link policy. For receive tickets the same paranoia
      // applies as before (link might have flipped to disabled/expired/etc).
      // For send tickets in #8 only `disabled` can change between mint and
      // finalize — but we still run the same code path because the policy
      // module owns the decision; future widening doesn't touch this site.
      if (ticketRow.intent === 'receive' && ticketRow.receiveLinkId !== null) {
        const link = await receiveLinksModule.getById(ticketRow.receiveLinkId);
        if (link) {
          const now = Math.floor(Date.now() / 1000);
          const uploadsSoFar = await receiveLinksModule.recordUploadCount(link.id);
          const passwordCheck = await resolvePasswordCheck(
            link.passwordHash,
            input?.providedPassword ?? null,
          );
          const policy = evaluateReceiveLink(link, now, uploadsSoFar, passwordCheck);
          if (policy.kind !== 'ok') {
            return { kind: 'policy_rejected', policy };
          }
        }
      } else if (ticketRow.intent === 'send' && ticketRow.sendLinkId !== null) {
        const link = await sendLinksModule.getById(ticketRow.sendLinkId);
        if (link) {
          // Same admin-bypass semantics as the mint path: only `disabled`
          // gates the admin's own finalize for a send link. Password / quota
          // / expiry are recipient-side concerns.
          if (link.status === 'disabled') {
            return { kind: 'policy_rejected', policy: { kind: 'disabled' } };
          }
        }
      }

      const info = await storage.headObject(ticketRow.s3Key);
      const completedAt = Math.floor(Date.now() / 1000);

      if (!info) {
        db.update(uploadTickets)
          .set({ status: 'failed', completedAt })
          .where(eq(uploadTickets.id, ticketId))
          .run();
        return { kind: 'failed', reason: 'object_not_found' };
      }

      // Trust the bucket's reported size over the client's hint — this is
      // the whole point of HEAD-then-record. ContentType may be missing on
      // some providers/configs; fall back to the ticket's claimed type.
      const fileId = randomUUID();
      await filesModule.create({
        id: fileId,
        s3Key: ticketRow.s3Key,
        filename: ticketRow.filename,
        contentType: info.contentType ?? ticketRow.contentType,
        size: info.size,
        receiveLinkId: ticketRow.receiveLinkId,
        sendLinkId: ticketRow.sendLinkId,
      });

      db.update(uploadTickets)
        .set({ status: 'completed', completedAt })
        .where(eq(uploadTickets.id, ticketId))
        .run();

      return { kind: 'completed', fileId };
    },
  };
}

/**
 * Sanitise a user-supplied filename for inclusion in a bucket key. The key is
 * not the source of truth for the display name (that's the DB row), but
 * including a recognisable name makes the bucket browser human-friendly.
 *
 * Strips: path separators, NULs, ASCII control chars. Collapses whitespace
 * but preserves single spaces. Caps length so a pathological filename can't
 * blow the key length limit. Falls back to `file` if the result is empty.
 *
 * The control-char range is built via `RegExp` at runtime so this source
 * file stays free of literal control bytes (clean diffs, no editor surprises).
 */
function sanitizeFilename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripControls = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
  const cleaned = raw
    .replace(stripControls, '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'file';
}

// Re-export for callers that still import the old surface name; keeps the
// public `ReceiveLink`/`SendLink` types out of this module's responsibility.
export type { ReceiveLink, SendLink };
