import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { downloadTickets, sendLinks } from '../db/schema.js';
import type { FilesModule } from '../files/files.js';
import { evaluateSendLink, type SendLinkPolicyResult } from '../links/policy/index.js';
import { resolvePasswordCheck } from '../links/policy/password-check.js';
import type { SendLinksModule } from '../links/send-links.js';
import type { StorageProvider } from '../storage/index.js';

/**
 * Download-ticket lifecycle. The mirror of `upload-tickets` on the recipient
 * side: a short-lived presigned GET handed out after the send link's policy
 * passes. Persisted with the URL for an audit trail; the URL goes stale
 * within minutes, so it is never re-served by any GET endpoint.
 *
 * Lifecycle (encoded by the PRD via #11):
 *
 *   - `createForSendLink` mints a `pending` ticket. NOT a quota burn — a user
 *     who fails to actually transfer the bytes should not exhaust the link.
 *   - `confirm(ticketId)` transitions `pending → completed` AND increments
 *     `send_links.download_count`. Wired to a best-effort public endpoint the
 *     browser hits right after starting the presigned GET. Idempotent: a
 *     second call on a `completed` row is a no-op.
 *   - `confirm(ticketId, { outcome: 'failed' })` transitions `pending → failed`
 *     WITHOUT incrementing the counter. The client uses this when it explicitly
 *     knows the transfer didn't start (e.g. the navigation was cancelled).
 *   - `expire(ticketId)` transitions `pending → expired` AND increments the
 *     counter. Called by the sweep (#10) for tickets the user never confirmed.
 *     The honest model: the server has no proof of completion, but a minted
 *     ticket IS a delivered URL — the bucket will hand the bytes to whoever
 *     calls it before the TTL. Burning the slot on expire is the correct
 *     conservative default.
 *
 * All transitions use a guarded `UPDATE ... WHERE status='pending'` so they
 * are inherently idempotent: the second call doesn't change rows and the
 * counter never double-bumps.
 *
 * Auth note: the public surface uses this module for the recipient flow. The
 * send link's code IS the authorization to enumerate files on it; the link's
 * policy (password / quota / status) gates the actual mint.
 */

export interface CreateForSendLinkInput {
  linkCode: string;
  fileId: string;
  providedPassword?: string | null;
}

export interface DownloadTicketResult {
  ticketId: string;
  presignedGetUrl: string;
  expiresAt: Date;
}

export type CreateForSendLinkOutcome =
  | { kind: 'ok'; value: DownloadTicketResult }
  | { kind: 'link_not_found' }
  | { kind: 'file_not_found' }
  | { kind: 'policy_rejected'; policy: SendLinkPolicyResult };

export type ConfirmOutcome =
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'already_completed' }
  | { kind: 'already_failed' }
  | { kind: 'already_expired' }
  | { kind: 'ticket_not_found' };

export type ExpireOutcome =
  | { kind: 'expired' }
  | { kind: 'already_completed' }
  | { kind: 'already_failed' }
  | { kind: 'already_expired' }
  | { kind: 'ticket_not_found' };

export interface DownloadTicketsModule {
  createForSendLink(input: CreateForSendLinkInput): Promise<CreateForSendLinkOutcome>;
  /**
   * Best-effort signal from the client that the presigned GET was handed off
   * to the bucket. Transitions `pending → completed` and burns one quota slot
   * (increments `send_links.download_count`). Idempotent: subsequent calls on
   * the same ticket are no-ops. `outcome: 'failed'` marks the ticket failed
   * WITHOUT burning quota — used when the client knows the transfer didn't
   * start.
   */
  confirm(ticketId: string, opts?: { outcome?: 'completed' | 'failed' }): Promise<ConfirmOutcome>;
  /**
   * Sweep-driven transition: `pending → expired`, burns one quota slot. Same
   * guarded-UPDATE pattern as `confirm`. Exposed as a module function so the
   * #10 cleanup sweep can call it without duplicating the transaction logic.
   */
  expire(ticketId: string): Promise<ExpireOutcome>;
}

export function createDownloadTicketsModule(
  db: Db,
  storage: StorageProvider,
  sendLinksModule: SendLinksModule,
  filesModule: FilesModule,
): DownloadTicketsModule {
  /**
   * Guarded transition + counter-burn, wrapped in a single SQLite transaction
   * so the ticket flip and the link counter bump succeed or fail together.
   *
   * `targetStatus` is the terminal status to write (`completed` for confirm,
   * `expired` for expire). The UPDATE is constrained to `pending` so a second
   * caller after a winning concurrent caller sees `changes === 0` and bails
   * before bumping the counter — that's how we get free idempotency.
   *
   * `burnQuota = true` is the confirm/expire path; `burnQuota = false` is the
   * "client cancelled before transfer" path (writes `failed`, no counter bump).
   */
  function transitionPending(
    ticketId: string,
    targetStatus: 'completed' | 'failed' | 'expired',
    burnQuota: boolean,
  ): { kind: 'ok' } | { kind: 'not_pending'; current: string } | { kind: 'not_found' } {
    return db.transaction((tx) => {
      const ticket = tx
        .select({ status: downloadTickets.status, sendLinkId: downloadTickets.sendLinkId })
        .from(downloadTickets)
        .where(eq(downloadTickets.id, ticketId))
        .get();
      if (!ticket) return { kind: 'not_found' as const };
      if (ticket.status !== 'pending') {
        return { kind: 'not_pending' as const, current: ticket.status };
      }

      const completedAt = Math.floor(Date.now() / 1000);
      const result = tx
        .update(downloadTickets)
        .set({ status: targetStatus, completedAt })
        .where(and(eq(downloadTickets.id, ticketId), eq(downloadTickets.status, 'pending')))
        .run();

      // Defensive: if the guarded UPDATE didn't flip the row (another tx beat
      // us inside this transaction's lifetime, theoretically impossible with
      // sqlite's serialized writes but cheap insurance), don't bump the counter.
      if (Number(result.changes) === 0) {
        return { kind: 'not_pending' as const, current: 'pending' };
      }

      if (burnQuota) {
        // Increment, not decrement: the counter starts at 0 and the policy
        // compare is `download_count >= max_downloads`. "Burning a quota slot"
        // is the conceptual decrement of *remaining* downloads.
        tx.update(sendLinks)
          .set({ downloadCount: sql`${sendLinks.downloadCount} + 1` })
          .where(eq(sendLinks.id, ticket.sendLinkId))
          .run();
      }
      return { kind: 'ok' as const };
    });
  }

  return {
    async createForSendLink(input) {
      const link = await sendLinksModule.getByCode(input.linkCode);
      if (!link) return { kind: 'link_not_found' };

      const now = Math.floor(Date.now() / 1000);
      const downloadsSoFar = await sendLinksModule.recordDownloadCount(link.id);
      const passwordCheck = await resolvePasswordCheck(
        link.passwordHash,
        input.providedPassword ?? null,
      );
      const policy = evaluateSendLink(link, now, downloadsSoFar, passwordCheck);
      if (policy.kind !== 'ok') {
        return { kind: 'policy_rejected', policy };
      }

      // Verify the requested file is actually attached to this link. Belt-
      // and-braces against an attacker who has one valid code and tries to
      // mint a ticket for a file from a different send link they don't have
      // access to.
      const file = await filesModule.getById(input.fileId);
      if (!file || file.sendLinkId !== link.id) {
        return { kind: 'file_not_found' };
      }

      // Sign the GET with `response-content-disposition: attachment` so the
      // recipient browser saves the file with its friendly DB name rather
      // than the opaque bucket key. Quotes / CR / LF are scrubbed to avoid
      // breaking the header on a maliciously-named file.
      const safeName = file.filename.replace(/[\\"\r\n]/g, '_');
      const presigned = await storage.presignGet(file.s3Key, {
        responseContentDisposition: `attachment; filename="${safeName}"`,
      });

      const ticketId = randomUUID();
      const expiresAtEpoch = Math.floor(presigned.expiresAt.getTime() / 1000);

      db.insert(downloadTickets)
        .values({
          id: ticketId,
          sendLinkId: link.id,
          fileId: file.id,
          s3Key: file.s3Key,
          filename: file.filename,
          presignedGetUrl: presigned.url,
          expiresAt: expiresAtEpoch,
          status: 'pending',
          createdAt: now,
          completedAt: null,
        })
        .run();

      return {
        kind: 'ok',
        value: {
          ticketId,
          presignedGetUrl: presigned.url,
          expiresAt: presigned.expiresAt,
        },
      };
    },

    async confirm(ticketId, opts) {
      const outcome = opts?.outcome ?? 'completed';
      const targetStatus = outcome === 'failed' ? 'failed' : 'completed';
      const burnQuota = outcome === 'completed';

      const result = transitionPending(ticketId, targetStatus, burnQuota);
      if (result.kind === 'not_found') return { kind: 'ticket_not_found' };
      if (result.kind === 'ok') {
        return outcome === 'failed' ? { kind: 'failed' } : { kind: 'completed' };
      }
      // Idempotent paths: the row is already in a terminal state. We surface
      // the specific state so a caller (the public route) can return a useful
      // body, but every "already_*" answer is success-shaped from the client's
      // perspective.
      switch (result.current) {
        case 'completed':
          return { kind: 'already_completed' };
        case 'failed':
          return { kind: 'already_failed' };
        case 'expired':
          return { kind: 'already_expired' };
        default:
          return { kind: 'ticket_not_found' };
      }
    },

    async expire(ticketId) {
      const result = transitionPending(ticketId, 'expired', true);
      if (result.kind === 'not_found') return { kind: 'ticket_not_found' };
      if (result.kind === 'ok') return { kind: 'expired' };
      switch (result.current) {
        case 'completed':
          return { kind: 'already_completed' };
        case 'failed':
          return { kind: 'already_failed' };
        case 'expired':
          return { kind: 'already_expired' };
        default:
          return { kind: 'ticket_not_found' };
      }
    },
  };
}
