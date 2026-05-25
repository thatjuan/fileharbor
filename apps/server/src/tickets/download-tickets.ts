import { randomUUID } from 'node:crypto';
import { verifyPassword } from '@better-auth/utils/password';

import type { Db } from '../db/client.js';
import { downloadTickets } from '../db/schema.js';
import type { FilesModule } from '../files/files.js';
import {
  evaluateSendLink,
  type PasswordCheck,
  type SendLinkPolicyResult,
} from '../links/policy/index.js';
import type { SendLinksModule } from '../links/send-links.js';
import type { StorageProvider } from '../storage/index.js';

/**
 * Download-ticket lifecycle. The mirror of `upload-tickets` on the recipient
 * side: a short-lived presigned GET handed out after the send link's policy
 * passes. Persisted with the URL for an audit trail; the URL goes stale
 * within minutes, so it is never re-served by any GET endpoint.
 *
 * This slice (#8) only implements `createForSendLink`. `confirm(ticketId)`
 * and the on-confirmation decrement of `send_links.download_count` land in
 * #11 alongside the quota policy that consumes the counter.
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

export interface DownloadTicketsModule {
  createForSendLink(input: CreateForSendLinkInput): Promise<CreateForSendLinkOutcome>;
}

async function resolvePasswordCheck(
  passwordHash: string | null,
  providedPassword: string | null,
): Promise<PasswordCheck> {
  if (passwordHash === null) return { kind: 'not_required' };
  if (providedPassword === null || providedPassword.length === 0) {
    return { kind: 'missing' };
  }
  const ok = await verifyPassword(passwordHash, providedPassword);
  return ok ? { kind: 'correct' } : { kind: 'wrong' };
}

export function createDownloadTicketsModule(
  db: Db,
  storage: StorageProvider,
  sendLinksModule: SendLinksModule,
  filesModule: FilesModule,
): DownloadTicketsModule {
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
  };
}
