import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import type { MultipartConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { pendingAborts, uploadTickets } from '../db/schema.js';
import type { FilesModule } from '../files/files.js';
import {
  evaluateReceiveLink,
  type ReceiveLinkPolicyResult,
} from '../links/policy/index.js';
import { resolvePasswordCheck } from '../links/policy/password-check.js';
import type { ReceiveLink, ReceiveLinksModule } from '../links/receive-links.js';
import type { SendLink, SendLinksModule } from '../links/send-links.js';
import type { NotificationsModule } from '../notifications/notifications.js';
import type { CompletedPart as StorageCompletedPart, StorageProvider } from '../storage/index.js';

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

export type UploadTicketStatus =
  | 'pending'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'aborting';

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

// ---------------------------------------------------------------------------
// Multipart upload types
// ---------------------------------------------------------------------------

export interface InitMultipartInput {
  linkCode: string;
  filename: string;
  contentType: string;
  size: number;
  providedPassword?: string | null;
}

export interface InitMultipartForSendLinkInput {
  sendLinkId: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface InitMultipartResult {
  ticketId: string;
  uploadId: string;
  partSize: number;
  expectedParts: number;
  /** First 100 parts inline; if expectedParts > 100, more available via getMultipartPartUrls(). */
  initialUrls: { partNumber: number; url: string }[];
  /** True iff expectedParts > 100. */
  paginated: boolean;
  /** ISO 8601 expiry of the part URLs (same TTL the local/s3 backend used). */
  expiresAt: string;
}

export type InitMultipartOutcome =
  | { kind: 'ok'; value: InitMultipartResult }
  | { kind: 'link_not_found' }
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult }
  | { kind: 'invalid_input'; reason: string };

export type InitMultipartForSendLinkOutcome =
  | { kind: 'ok'; value: InitMultipartResult }
  | { kind: 'link_not_found' }
  | { kind: 'policy_rejected'; policy: { kind: 'disabled' } }
  | { kind: 'invalid_input'; reason: string };

export interface PartUrlsResult {
  urls: { partNumber: number; url: string }[];
  /** ISO 8601 expiry of the part URLs (same TTL the backend used). */
  expiresAt: string;
}

export type PartUrlsOutcome =
  | { kind: 'ok'; value: PartUrlsResult }
  | { kind: 'ticket_not_found' }
  | { kind: 'not_multipart' }
  | { kind: 'wrong_state' }
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult }
  | { kind: 'invalid_input'; reason: string };

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export type CompleteMultipartOutcome =
  | { kind: 'completed'; fileId: string }
  | {
      kind: 'failed';
      reason: 'invalid_parts' | 'storage_complete_failed' | 'object_not_found' | 'wrong_state';
    }
  | { kind: 'ticket_not_found' }
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult };

export type AbortMultipartOutcome =
  | { kind: 'aborted' }
  | { kind: 'already_aborted' }
  | { kind: 'already_completed' }
  | { kind: 'ticket_not_found' };

/**
 * Shape of the row returned by `findByUploadId` — narrow to multipart-only
 * tickets so the consumer (the local part-receive route) can rely on the
 * multipart-only columns (`partSize`, `expectedParts`) being non-null.
 */
export interface MultipartTicketLookup {
  id: string;
  status: UploadTicketStatus;
  expectedParts: number;
  partSize: number;
  s3Key: string;
}

export interface UploadTicketsModule {
  createForReceiveLink(input: CreateForReceiveLinkInput): Promise<CreateForReceiveLinkOutcome>;
  createForSendLink(input: CreateForSendLinkInput): Promise<CreateForSendLinkOutcome>;
  finalize(
    ticketId: string,
    input?: { providedPassword?: string | null },
  ): Promise<FinalizeOutcome>;
  initMultipart(input: InitMultipartInput): Promise<InitMultipartOutcome>;
  initMultipartForSendLink(
    input: InitMultipartForSendLinkInput,
  ): Promise<InitMultipartForSendLinkOutcome>;
  getMultipartPartUrls(
    ticketId: string,
    from: number,
    to: number,
    providedPassword?: string | null,
  ): Promise<PartUrlsOutcome>;
  completeMultipart(
    ticketId: string,
    input: { parts: CompletedPart[]; providedPassword?: string | null },
  ): Promise<CompleteMultipartOutcome>;
  abortMultipart(
    ticketId: string,
    input?: { providedPassword?: string | null },
  ): Promise<AbortMultipartOutcome>;
  /**
   * Lookup helper for the local part-receive route. Returns null when no
   * multipart ticket with that uploadId exists. Multipart-only columns are
   * non-null on the returned row (the query filters `protocol='multipart'`).
   */
  findByUploadId(uploadId: string): Promise<MultipartTicketLookup | null>;
}

/**
 * Shared validation for both intents — same checks, same error strings.
 *
 * The `maxObjectSizeBytes` ceiling is the hard cap that applies to BOTH the
 * single-PUT and multipart paths. Rejecting at the input layer is cheaper
 * than discovering a too-large object after `presignPut`/`initMultipart` has
 * already opened a storage session.
 */
function validateUploadInput(
  input: {
    filename: string;
    contentType: string;
    sizeHint: number;
  },
  maxObjectSizeBytes: number,
): { ok: true; filename: string; contentType: string } | { ok: false; reason: string } {
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
  if (input.sizeHint > maxObjectSizeBytes) {
    return { ok: false, reason: 'size_too_large' };
  }
  return { ok: true, filename, contentType };
}

export function createUploadTicketsModule(
  db: Db,
  storage: StorageProvider,
  receiveLinksModule: ReceiveLinksModule,
  sendLinksModule: SendLinksModule,
  filesModule: FilesModule,
  notificationsModule: NotificationsModule,
  multipartConfig: MultipartConfig,
): UploadTicketsModule {
  const { maxObjectSizeBytes, partSizeBytes } = multipartConfig;
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

  /**
   * Build the first batch (up to 100) of presigned part URLs for a freshly
   * opened multipart session. Returns the URLs along with the ISO 8601
   * expiry captured from the first presign (every part in the batch shares
   * the same per-URL TTL).
   */
  async function presignInitialPartUrls(
    s3Key: string,
    uploadId: string,
    expectedParts: number,
  ): Promise<{ initialUrls: { partNumber: number; url: string }[]; expiresAt: Date }> {
    const limit = Math.min(100, expectedParts);
    const initialUrls: { partNumber: number; url: string }[] = [];
    let expiresAt: Date | null = null;
    for (let n = 1; n <= limit; n++) {
      const presigned = await storage.presignUploadPart(s3Key, uploadId, n);
      if (expiresAt === null) expiresAt = presigned.expiresAt;
      initialUrls.push({ partNumber: n, url: presigned.url });
    }
    // `limit` is at least 1 here because the multipart paths require
    // `size > 0`; `expectedParts = ceil(size / partSize)` is always >= 1.
    return { initialUrls, expiresAt: expiresAt ?? new Date() };
  }

  /**
   * Re-run the receive-link policy gate for a ticket already in flight.
   * Used by every state-changing receive-side multipart operation (init is
   * handled separately because it needs the link code; this one looks the
   * link up by id from the ticket row). Returns null on `ok`; the rejected
   * verdict on anything else.
   */
  async function reRunReceivePolicy(
    receiveLinkId: string,
    providedPassword: string | null | undefined,
  ): Promise<ReceiveLinkPolicyResult | null> {
    const link = await receiveLinksModule.getById(receiveLinkId);
    if (!link) return null;
    const now = Math.floor(Date.now() / 1000);
    const uploadsSoFar = await receiveLinksModule.recordUploadCount(link.id);
    const passwordCheck = await resolvePasswordCheck(
      link.passwordHash,
      providedPassword ?? null,
    );
    const policy = evaluateReceiveLink(link, now, uploadsSoFar, passwordCheck);
    if (policy.kind === 'ok') return null;
    return policy;
  }

  return {
    async createForReceiveLink(input) {
      const validated = validateUploadInput(input, maxObjectSizeBytes);
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
      const validated = validateUploadInput(input, maxObjectSizeBytes);
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

      // Notifications: inbound (receive-intent) uploads only. Admin send-link
      // uploads do NOT produce a notification (PRD: in-app on inbound only).
      //
      // This insert is intentionally placed AFTER the file row is created and
      // the ticket is marked completed — never inside the already-completed
      // idempotency branch above. That keeps "one upload = exactly one
      // notification" honest even if a flaky client double-finalizes.
      //
      // Wrapped in try/catch so a notification failure cannot fail the upload:
      // the bytes are already in the bucket and the file row is committed; a
      // missing notification is a downstream cosmetic loss, not data loss.
      if (ticketRow.intent === 'receive' && ticketRow.receiveLinkId !== null) {
        try {
          const link = await receiveLinksModule.getById(ticketRow.receiveLinkId);
          await notificationsModule.record('upload_received', {
            receiveLinkId: ticketRow.receiveLinkId,
            // Defensive null-coalesce: a cascade-delete of the link between
            // HEAD and notify is theoretically possible. Surface a placeholder
            // rather than fail — the file still exists and is admin-visible.
            receiveLinkLabel: link?.label ?? 'unknown',
            fileId,
            filename: ticketRow.filename,
            size: info.size,
          });
        } catch (err) {
          console.error('[upload-tickets] notification record failed', {
            ticketId,
            fileId,
            err,
          });
        }
      }

      return { kind: 'completed', fileId };
    },

    // -----------------------------------------------------------------------
    // Multipart upload protocol
    // -----------------------------------------------------------------------

    async initMultipart(input) {
      // Mirror of `createForReceiveLink`: validation, link resolution, full
      // policy gate, then mint + storage init.
      const validated = validateUploadInput(
        { filename: input.filename, contentType: input.contentType, sizeHint: input.size },
        maxObjectSizeBytes,
      );
      if (!validated.ok) return { kind: 'invalid_input', reason: validated.reason };
      if (input.size <= 0) return { kind: 'invalid_input', reason: 'invalid_size' };

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

      const ticketId = randomUUID();
      const s3Key = `receive/${link.id}/${ticketId}/${validated.filename}`;

      const init = await storage.initMultipart(s3Key, {
        sizeHint: input.size,
        contentType: validated.contentType,
        partSizeBytes,
      });

      db.insert(uploadTickets)
        .values({
          id: ticketId,
          intent: 'receive',
          receiveLinkId: link.id,
          sendLinkId: null,
          s3Key,
          filename: validated.filename,
          contentType: validated.contentType,
          sizeHint: input.size,
          status: 'pending',
          protocol: 'multipart',
          uploadId: init.uploadId,
          partSize: init.partSize,
          expectedParts: init.expectedParts,
          createdAt: now,
          completedAt: null,
        })
        .run();

      const { initialUrls, expiresAt } = await presignInitialPartUrls(
        s3Key,
        init.uploadId,
        init.expectedParts,
      );

      console.log('[upload-tickets] multipart-init', {
        ticketId,
        key: s3Key,
        partSize: init.partSize,
        expectedParts: init.expectedParts,
      });

      return {
        kind: 'ok',
        value: {
          ticketId,
          uploadId: init.uploadId,
          partSize: init.partSize,
          expectedParts: init.expectedParts,
          initialUrls,
          paginated: init.expectedParts > 100,
          expiresAt: expiresAt.toISOString(),
        },
      };
    },

    async initMultipartForSendLink(input) {
      const validated = validateUploadInput(
        { filename: input.filename, contentType: input.contentType, sizeHint: input.size },
        maxObjectSizeBytes,
      );
      if (!validated.ok) return { kind: 'invalid_input', reason: validated.reason };
      if (input.size <= 0) return { kind: 'invalid_input', reason: 'invalid_size' };

      const link = await sendLinksModule.getById(input.sendLinkId);
      if (!link) return { kind: 'link_not_found' };
      if (link.status === 'disabled') {
        return { kind: 'policy_rejected', policy: { kind: 'disabled' } };
      }

      const ticketId = randomUUID();
      const s3Key = `send/${link.id}/${ticketId}/${validated.filename}`;

      const init = await storage.initMultipart(s3Key, {
        sizeHint: input.size,
        contentType: validated.contentType,
        partSizeBytes,
      });

      const now = Math.floor(Date.now() / 1000);
      db.insert(uploadTickets)
        .values({
          id: ticketId,
          intent: 'send',
          receiveLinkId: null,
          sendLinkId: link.id,
          s3Key,
          filename: validated.filename,
          contentType: validated.contentType,
          sizeHint: input.size,
          status: 'pending',
          protocol: 'multipart',
          uploadId: init.uploadId,
          partSize: init.partSize,
          expectedParts: init.expectedParts,
          createdAt: now,
          completedAt: null,
        })
        .run();

      const { initialUrls, expiresAt } = await presignInitialPartUrls(
        s3Key,
        init.uploadId,
        init.expectedParts,
      );

      console.log('[upload-tickets] multipart-init', {
        ticketId,
        key: s3Key,
        partSize: init.partSize,
        expectedParts: init.expectedParts,
      });

      return {
        kind: 'ok',
        value: {
          ticketId,
          uploadId: init.uploadId,
          partSize: init.partSize,
          expectedParts: init.expectedParts,
          initialUrls,
          paginated: init.expectedParts > 100,
          expiresAt: expiresAt.toISOString(),
        },
      };
    },

    async getMultipartPartUrls(ticketId, from, to, providedPassword) {
      const ticketRow = db.select().from(uploadTickets).where(eq(uploadTickets.id, ticketId)).get();
      if (!ticketRow) return { kind: 'ticket_not_found' };
      if (ticketRow.protocol !== 'multipart') return { kind: 'not_multipart' };
      if (ticketRow.status !== 'pending') return { kind: 'wrong_state' };
      if (ticketRow.uploadId === null || ticketRow.expectedParts === null) {
        // Defensive: a multipart row with NULL multipart columns is
        // structurally broken. Treat as wrong_state rather than 500.
        return { kind: 'wrong_state' };
      }

      // Range validation: positive ints, ordered, within expectedParts, and
      // per-call batch cap of 100. Mirrors the wire-protocol contract (R6).
      if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 1 ||
        to < from ||
        to > ticketRow.expectedParts ||
        to - from + 1 > 100
      ) {
        return { kind: 'invalid_input', reason: 'invalid_range' };
      }

      // Receive-side: re-run policy (catches link disable / quota changes
      // between init and the paged URL fetch). Send-side: only `disabled`
      // could change between init and now, and the route layer is
      // requireAdmin-gated; we only verify the admin's own disable toggle.
      if (ticketRow.intent === 'receive' && ticketRow.receiveLinkId !== null) {
        const rejected = await reRunReceivePolicy(ticketRow.receiveLinkId, providedPassword);
        if (rejected !== null) return { kind: 'policy_rejected', policy: rejected };
      } else if (ticketRow.intent === 'send' && ticketRow.sendLinkId !== null) {
        const link = await sendLinksModule.getById(ticketRow.sendLinkId);
        if (link && link.status === 'disabled') {
          // Surface as wrong_state — admin disabled the link mid-upload;
          // there's no recipient password verdict shape that applies.
          return { kind: 'wrong_state' };
        }
      }

      const urls: { partNumber: number; url: string }[] = [];
      let expiresAt: Date | null = null;
      for (let n = from; n <= to; n++) {
        const presigned = await storage.presignUploadPart(ticketRow.s3Key, ticketRow.uploadId, n);
        if (expiresAt === null) expiresAt = presigned.expiresAt;
        urls.push({ partNumber: n, url: presigned.url });
      }

      return {
        kind: 'ok',
        value: { urls, expiresAt: (expiresAt ?? new Date()).toISOString() },
      };
    },

    async completeMultipart(ticketId, input) {
      const ticketRow = db.select().from(uploadTickets).where(eq(uploadTickets.id, ticketId)).get();
      if (!ticketRow) return { kind: 'ticket_not_found' };

      // Idempotency on `completed`: return the same fileId without doing any
      // work. Mirrors the existing single-PUT `finalize` branch above.
      if (ticketRow.status === 'completed') {
        const list =
          ticketRow.intent === 'receive'
            ? await filesModule.listForReceiveLink(ticketRow.receiveLinkId ?? '')
            : await filesModule.listForSendLink(ticketRow.sendLinkId ?? '');
        const existing = list.find((f) => f.s3Key === ticketRow.s3Key);
        return { kind: 'completed', fileId: existing?.id ?? '' };
      }
      // Any non-pending status is closed to completion: another caller is
      // racing the complete, sweep has begun teardown, or the session is
      // already gone.
      if (
        ticketRow.status === 'aborting' ||
        ticketRow.status === 'expired' ||
        ticketRow.status === 'failed' ||
        ticketRow.status === 'completing'
      ) {
        return { kind: 'failed', reason: 'wrong_state' };
      }
      // Only the multipart path proceeds beyond here; a single-PUT row in
      // `pending` should go through `finalize`, not `completeMultipart`.
      if (ticketRow.protocol !== 'multipart') {
        return { kind: 'failed', reason: 'wrong_state' };
      }
      if (
        ticketRow.uploadId === null ||
        ticketRow.expectedParts === null ||
        ticketRow.partSize === null
      ) {
        return { kind: 'failed', reason: 'wrong_state' };
      }

      // Re-run policy BEFORE the CAS — a rejection leaves the ticket in
      // `pending` so the user can retry once policy re-allows (matches
      // existing `finalize`'s policy stance; lifecycle-security §1.4).
      if (ticketRow.intent === 'receive' && ticketRow.receiveLinkId !== null) {
        const rejected = await reRunReceivePolicy(ticketRow.receiveLinkId, input.providedPassword);
        if (rejected !== null) return { kind: 'policy_rejected', policy: rejected };
      } else if (ticketRow.intent === 'send' && ticketRow.sendLinkId !== null) {
        const link = await sendLinksModule.getById(ticketRow.sendLinkId);
        if (link && link.status === 'disabled') {
          return { kind: 'failed', reason: 'wrong_state' };
        }
      }

      // CAS to `completing` — guards against a concurrent abort/sweep
      // flipping the row to `aborting`.
      const cas = db
        .update(uploadTickets)
        .set({ status: 'completing' })
        .where(
          and(
            eq(uploadTickets.id, ticketId),
            eq(uploadTickets.status, 'pending'),
            eq(uploadTickets.protocol, 'multipart'),
          ),
        )
        .run();
      if (Number(cas.changes) === 0) {
        // Someone won the race; re-query and translate.
        return { kind: 'failed', reason: 'wrong_state' };
      }

      // Validate the parts payload: exact count, no gaps, no dupes, all
      // partNumbers in [1, expectedParts], non-empty etags.
      const partsInvalid =
        !Array.isArray(input.parts) ||
        input.parts.length !== ticketRow.expectedParts ||
        (() => {
          const seen = new Set<number>();
          for (const p of input.parts) {
            if (!Number.isInteger(p.partNumber)) return true;
            if (p.partNumber < 1 || p.partNumber > (ticketRow.expectedParts ?? 0)) return true;
            if (seen.has(p.partNumber)) return true;
            if (typeof p.etag !== 'string' || p.etag.length === 0) return true;
            seen.add(p.partNumber);
          }
          return seen.size !== ticketRow.expectedParts;
        })();
      if (partsInvalid) {
        // Release the CAS so the user can retry with a corrected payload.
        db.update(uploadTickets)
          .set({ status: 'pending' })
          .where(
            and(eq(uploadTickets.id, ticketId), eq(uploadTickets.status, 'completing')),
          )
          .run();
        return { kind: 'failed', reason: 'invalid_parts' };
      }

      const partsForStorage: StorageCompletedPart[] = input.parts.map((p) => ({
        partNumber: p.partNumber,
        etag: p.etag,
      }));

      try {
        await storage.completeMultipart(ticketRow.s3Key, ticketRow.uploadId, partsForStorage);
      } catch (err) {
        // Storage failed — the multipart session may or may not be cleaned
        // up. Enqueue a durable abort so sweep Phase 1.7 reaps it; flip the
        // ticket to terminal `failed`.
        const now = Math.floor(Date.now() / 1000);
        db.insert(pendingAborts)
          .values({
            s3Key: ticketRow.s3Key,
            uploadId: ticketRow.uploadId,
            reason: 'complete_failed',
            enqueuedAt: now,
            attempts: 0,
          })
          .onConflictDoNothing()
          .run();
        db.update(uploadTickets)
          .set({ status: 'failed', completedAt: now })
          .where(
            and(eq(uploadTickets.id, ticketId), eq(uploadTickets.status, 'completing')),
          )
          .run();
        console.warn('[upload-tickets] multipart-complete-failed', {
          ticketId,
          key: ticketRow.s3Key,
          err: err instanceof Error ? err.message : String(err),
        });
        return { kind: 'failed', reason: 'storage_complete_failed' };
      }

      // Mirror the existing `finalize` HEAD-then-record idiom. Treat a
      // missing object as `complete_failed` (storage said success but the
      // object isn't there — should not happen, but defence in depth).
      const info = await storage.headObject(ticketRow.s3Key);
      if (!info) {
        const now = Math.floor(Date.now() / 1000);
        db.update(uploadTickets)
          .set({ status: 'failed', completedAt: now })
          .where(
            and(eq(uploadTickets.id, ticketId), eq(uploadTickets.status, 'completing')),
          )
          .run();
        return { kind: 'failed', reason: 'object_not_found' };
      }

      // Trust the bucket's reported size; log a warn on mismatch but proceed
      // (mirrors existing `finalize`).
      if (ticketRow.sizeHint !== null && info.size !== ticketRow.sizeHint) {
        console.warn('[upload-tickets] multipart-complete size mismatch (trusting bucket)', {
          ticketId,
          key: ticketRow.s3Key,
          sizeHint: ticketRow.sizeHint,
          bucketSize: info.size,
        });
      }

      const completedAt = Math.floor(Date.now() / 1000);
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
        .where(
          and(eq(uploadTickets.id, ticketId), eq(uploadTickets.status, 'completing')),
        )
        .run();

      // Notification (receive intent only). Same try/catch shape as
      // `finalize` — a notification failure cannot fail the upload.
      if (ticketRow.intent === 'receive' && ticketRow.receiveLinkId !== null) {
        try {
          const link = await receiveLinksModule.getById(ticketRow.receiveLinkId);
          await notificationsModule.record('upload_received', {
            receiveLinkId: ticketRow.receiveLinkId,
            receiveLinkLabel: link?.label ?? 'unknown',
            fileId,
            filename: ticketRow.filename,
            size: info.size,
          });
        } catch (err) {
          console.error('[upload-tickets] notification record failed', {
            ticketId,
            fileId,
            err,
          });
        }
      }

      return { kind: 'completed', fileId };
    },

    async abortMultipart(ticketId, _input) {
      const ticketRow = db.select().from(uploadTickets).where(eq(uploadTickets.id, ticketId)).get();
      if (!ticketRow) return { kind: 'ticket_not_found' };

      // Branch by current status. `completing` is treated as already_completed
      // per lifecycle-security §1 — complete wins ties; we don't try to cancel
      // an in-flight CompleteMultipart.
      if (ticketRow.status === 'completed' || ticketRow.status === 'completing') {
        return { kind: 'already_completed' };
      }
      if (ticketRow.status === 'expired' || ticketRow.status === 'failed') {
        return { kind: 'already_aborted' };
      }
      if (ticketRow.status === 'aborting') {
        // Sweep / a prior call owns the in-flight storage teardown; UX-wise
        // treat as success (the user asked us to cancel; we are cancelling).
        return { kind: 'already_aborted' };
      }
      // Only multipart rows have a session to tear down.
      if (ticketRow.protocol !== 'multipart' || ticketRow.uploadId === null) {
        // Single-PUT pending — no session; report as aborted so the caller
        // sees idempotent success. The sweep will eventually flip the
        // single-PUT row to `expired` via its usual TTL path.
        return { kind: 'aborted' };
      }

      // CAS to `aborting`.
      const cas = db
        .update(uploadTickets)
        .set({ status: 'aborting' })
        .where(
          and(eq(uploadTickets.id, ticketId), eq(uploadTickets.status, 'pending')),
        )
        .run();
      if (Number(cas.changes) === 0) {
        // Lost race — re-query and translate.
        const fresh = db.select().from(uploadTickets).where(eq(uploadTickets.id, ticketId)).get();
        if (!fresh) return { kind: 'ticket_not_found' };
        if (fresh.status === 'completed' || fresh.status === 'completing') {
          return { kind: 'already_completed' };
        }
        return { kind: 'already_aborted' };
      }

      // Fire the storage abort. On success, flip to terminal `expired`. On
      // failure, leave in `aborting` for sweep Phase 1.6 to drain — return
      // success to the caller anyway (best-effort UX promise; the bytes are
      // not visible regardless).
      try {
        await storage.abortMultipart(ticketRow.s3Key, ticketRow.uploadId);
        const now = Math.floor(Date.now() / 1000);
        db.update(uploadTickets)
          .set({ status: 'expired', completedAt: now })
          .where(
            and(eq(uploadTickets.id, ticketId), eq(uploadTickets.status, 'aborting')),
          )
          .run();
      } catch (err) {
        console.warn('[upload-tickets] multipart-abort storage call failed; sweep will retry', {
          ticketId,
          key: ticketRow.s3Key,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return { kind: 'aborted' };
    },

    async findByUploadId(uploadId) {
      // The query filters `protocol='multipart'` so the multipart-only
      // columns are guaranteed non-null in the returned row.
      const row = db
        .select({
          id: uploadTickets.id,
          status: uploadTickets.status,
          expectedParts: uploadTickets.expectedParts,
          partSize: uploadTickets.partSize,
          s3Key: uploadTickets.s3Key,
        })
        .from(uploadTickets)
        .where(
          and(
            eq(uploadTickets.uploadId, uploadId),
            eq(uploadTickets.protocol, 'multipart'),
          ),
        )
        .get();
      if (!row) return Promise.resolve(null);
      // Defensive null-check: schema permits NULL but the WHERE excludes it
      // for multipart rows in practice. If somehow they're NULL, refuse.
      if (row.expectedParts === null || row.partSize === null) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        id: row.id,
        status: row.status,
        expectedParts: row.expectedParts,
        partSize: row.partSize,
        s3Key: row.s3Key,
      });
    },
  };
}

/**
 * Sanitise a user-supplied filename for inclusion in a storage key. The key
 * is not the source of truth for the display name (that's the DB row), but
 * including a recognisable name makes the bucket browser / on-disk tree
 * human-friendly.
 *
 * Allowed chars: `[A-Za-z0-9._-]`. Anything else (spaces, accents, slashes,
 * control chars, ...) collapses to `_`. This matches the key character
 * class enforced by the local storage backend (`storage/signing.ts`), so
 * the same key string is acceptable to either backend with no re-encoding.
 *
 * Caps length at 200 chars so a pathological filename can't blow the key
 * length limit. Falls back to `file` if the result is empty.
 */
function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'file';
}

// Re-export for callers that still import the old surface name; keeps the
// public `ReceiveLink`/`SendLink` types out of this module's responsibility.
export type { ReceiveLink, SendLink };
