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
 * Quota model: one minted URL is one download, recorded at mint. The bucket
 * hands the bytes to whoever calls the presigned GET before its TTL, and the
 * server has no proof a download did or didn't happen, so the only honest
 * place to count is the moment the URL leaves the server.
 *
 *   - `createForSendLink` checks `download_count < max_downloads`, increments
 *     `send_links.download_count` and inserts a `pending` ticket in one
 *     SQLite transaction, so concurrent mints can never overshoot the cap.
 *   - `confirm(ticketId)` transitions `pending → completed`. Best-effort
 *     signal from the browser right after it starts the presigned GET.
 *   - `confirm(ticketId, { outcome: 'failed' })` transitions `pending →
 *     failed`. Recorded for status display only; it never refunds quota,
 *     because a client-asserted failure can't be verified.
 *   - `expire(ticketId)` transitions `pending → expired`. Called by the sweep
 *     (#10) for tickets nobody confirmed.
 *
 * confirm and expire record the outcome only. All transitions use a guarded
 * `UPDATE ... WHERE status='pending'` so they are idempotent.
 *
 * Auth note: the public surface uses this module for the recipient flow. The
 * send link's code IS the authorization to see the link; the link's policy
 * (password / quota / status) gates the actual mint.
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
   * to the bucket. Transitions `pending → completed`, or `pending → failed`
   * with `outcome: 'failed'`. Quota was already burned at mint, so neither
   * outcome touches `send_links.download_count`. Idempotent: subsequent calls
   * on the same ticket are no-ops.
   */
  confirm(ticketId: string, opts?: { outcome?: 'completed' | 'failed' }): Promise<ConfirmOutcome>;
  /**
   * Sweep-driven transition: `pending → expired`. Same guarded-UPDATE pattern
   * as `confirm`, and like it, leaves the download counter alone. Exposed as a module function so the
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
   * Guarded `pending → targetStatus` flip. The UPDATE is constrained to
   * `pending`, so a second caller sees `changes === 0` and reports the
   * current status instead: that's how confirm and expire stay idempotent.
   */
  function transitionPending(
    ticketId: string,
    targetStatus: 'completed' | 'failed' | 'expired',
  ): { kind: 'ok' } | { kind: 'not_pending'; current: string } | { kind: 'not_found' } {
    return db.transaction((tx) => {
      const ticket = tx
        .select({ status: downloadTickets.status })
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
      if (Number(result.changes) === 0) {
        return { kind: 'not_pending' as const, current: 'pending' };
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

      // The policy check above is advisory (it gives disabled / expired /
      // password their error shapes). The authoritative quota check runs here,
      // in the same synchronous transaction as the counter bump and the ticket
      // insert, so two concurrent mints can't both take the last slot.
      const reserved = db.transaction((tx) => {
        const row = tx
          .select({ downloadCount: sendLinks.downloadCount, maxDownloads: sendLinks.maxDownloads })
          .from(sendLinks)
          .where(eq(sendLinks.id, link.id))
          .get();
        if (!row) return { kind: 'link_gone' as const };
        if (row.maxDownloads !== null && row.downloadCount >= row.maxDownloads) {
          return { kind: 'quota_exhausted' as const };
        }
        tx.update(sendLinks)
          .set({ downloadCount: sql`${sendLinks.downloadCount} + 1` })
          .where(eq(sendLinks.id, link.id))
          .run();
        tx.insert(downloadTickets)
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
        return { kind: 'ok' as const };
      });

      switch (reserved.kind) {
        case 'link_gone':
          return { kind: 'link_not_found' };
        case 'quota_exhausted':
          return { kind: 'policy_rejected', policy: { kind: 'quota_exhausted' } };
        case 'ok':
          break;
      }

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
      const result = transitionPending(ticketId, outcome);
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
      const result = transitionPending(ticketId, 'expired');
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
