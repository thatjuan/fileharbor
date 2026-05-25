import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { uploadTickets } from '../db/schema.js';
import type { FilesModule } from '../files/files.js';
import { evaluateReceiveLink, type ReceiveLinkPolicyResult } from '../links/policy/index.js';
import type { ReceiveLinksModule } from '../links/receive-links.js';
import type { StorageProvider } from '../storage/index.js';

/**
 * Upload-ticket lifecycle. Two operations:
 *
 *   - `createForReceiveLink` — validates link via `policy`, mints an S3 key,
 *     calls `storage.presignPut` (signing the claimed `Content-Type` so a
 *     mismatched upload fails with `SignatureDoesNotMatch` rather than landing
 *     silently-wrong), persists the ticket as `pending`, returns the URL and
 *     ticket id.
 *
 *   - `finalize` — calls `storage.headObject`. On success: creates a `file`
 *     record bound to the link, marks the ticket `completed`. On missing
 *     object: marks the ticket `failed` and does NOT create a file row.
 *     Idempotent on completed: re-calls return the existing status with no
 *     side effects. Re-finalize is allowed on `failed` (the uploader may
 *     retry the PUT then re-finalize).
 *
 * The bucket key shape is `receive/<link_id>/<ticket_id>/<filename>` per
 * PRD. `<filename>` is included for human-legible logs in the bucket browser
 * but is sanitised — slashes, control chars, and NULs are stripped, and a
 * fallback name is used if the result is empty. The DB row is the source of
 * truth for the displayed filename; the key is opaque.
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

export type FinalizeOutcome =
  | { kind: 'completed'; fileId: string }
  | { kind: 'failed'; reason: 'object_not_found' }
  | { kind: 'ticket_not_found' }
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult };

export interface UploadTicketsModule {
  createForReceiveLink(input: CreateForReceiveLinkInput): Promise<CreateForReceiveLinkOutcome>;
  finalize(
    ticketId: string,
    input?: { providedPassword?: string | null },
  ): Promise<FinalizeOutcome>;
}

export function createUploadTicketsModule(
  db: Db,
  storage: StorageProvider,
  receiveLinksModule: ReceiveLinksModule,
  filesModule: FilesModule,
): UploadTicketsModule {
  return {
    async createForReceiveLink(input) {
      const filename = sanitizeFilename(input.filename);
      if (filename.length === 0) {
        return { kind: 'invalid_input', reason: 'filename_required' };
      }
      const contentType = input.contentType.trim();
      if (contentType.length === 0) {
        return { kind: 'invalid_input', reason: 'content_type_required' };
      }
      if (!Number.isInteger(input.sizeHint) || input.sizeHint < 0) {
        return { kind: 'invalid_input', reason: 'invalid_size' };
      }

      const link = await receiveLinksModule.getByCode(input.linkCode);
      if (!link) return { kind: 'link_not_found' };

      const now = Math.floor(Date.now() / 1000);
      const uploadsSoFar = await receiveLinksModule.recordUploadCount(link.id);
      const policy = evaluateReceiveLink(link, now, uploadsSoFar, input.providedPassword ?? null);
      if (policy.kind !== 'ok') {
        return { kind: 'policy_rejected', policy };
      }

      const ticketId = randomUUID();
      const s3Key = `receive/${link.id}/${ticketId}/${filename}`;

      const presigned = await storage.presignPut(s3Key, {
        contentType,
        contentLength: input.sizeHint,
      });

      db.insert(uploadTickets)
        .values({
          id: ticketId,
          intent: 'receive',
          receiveLinkId: link.id,
          sendLinkId: null,
          s3Key,
          filename,
          contentType,
          sizeHint: input.sizeHint,
          status: 'pending',
          createdAt: now,
          completedAt: null,
        })
        .run();

      return {
        kind: 'ok',
        value: {
          ticketId,
          presignedPutUrl: presigned.url,
          expiresAt: presigned.expiresAt,
        },
      };
    },

    async finalize(ticketId, _input) {
      const ticketRow = db.select().from(uploadTickets).where(eq(uploadTickets.id, ticketId)).get();
      if (!ticketRow) return { kind: 'ticket_not_found' };

      // Idempotency on completed: if a finalize call previously created the
      // file row and marked the ticket completed, return the same answer with
      // no extra work. We look up the `file` row by `s3_key` (the ticket-file
      // pairing is 1:1) and return its id so the caller can still link to it.
      if (ticketRow.status === 'completed') {
        const existing = await filesModule
          .listForReceiveLink(ticketRow.receiveLinkId ?? '')
          .then((list) => list.find((f) => f.s3Key === ticketRow.s3Key));
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
