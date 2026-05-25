import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '@better-auth/utils/password';

import type { Db } from '../db/client.js';
import { files, sendLinks } from '../db/schema.js';
import { mintUniqueCode, normalizeCode } from './code-generator.js';

/**
 * CRUD over `send_links` plus the aggregate `recordDownloadCount` and
 * `recordFileCount` views. Parallel in shape to `receive-links.ts` — same
 * facade pattern, same id/code conventions, same code-generator probe.
 *
 * For #8 only `create`, `getByCode`, `getById`, `list`, and the two
 * aggregate views are wired. `update` / `remove` are left for #12 (send link
 * lifecycle: disable/re-enable/delete); password / quota / expiry policy is
 * #11. The accept-and-store columns for those fields already exist on the
 * schema so this slice can persist `null`s without another migration.
 */

export interface SendLink {
  id: string;
  code: string;
  label: string;
  passwordHash: string | null;
  maxDownloads: number | null;
  /** Running tally of completed recipient downloads. Pre-baked; stays 0 in #8. */
  downloadCount: number;
  /** Unix epoch seconds, UTC. */
  expiresAt: number | null;
  status: 'active' | 'disabled';
  createdAt: number;
}

export interface SendLinksModule {
  create(input: CreateSendLinkInput): Promise<SendLink>;
  getByCode(code: string): Promise<SendLink | null>;
  getById(id: string): Promise<SendLink | null>;
  list(): Promise<SendLink[]>;
  /**
   * Compensating remove — used when a caller (e.g. atomic create-link-and-ticket)
   * needs to roll back a freshly-created link because a downstream step failed.
   * Returns `true` when a row was removed.
   *
   * Public delete (with all its policy + cascade nuances) lands in #12; this
   * is the narrow internal lifecycle hook the create-and-mint flow needs.
   */
  remove(id: string): Promise<boolean>;
  /**
   * Persisted download counter on the link row. Cheap O(1) read; returned by
   * #8's policy display computation and #11's quota check.
   */
  recordDownloadCount(linkId: string): Promise<number>;
  /**
   * Count of files attached to this send link. Useful for "has the admin
   * upload finalised yet?" and for the dashboard summary. Computed on demand
   * from `files`, like `receive-links.recordUploadCount`.
   */
  recordFileCount(linkId: string): Promise<number>;
}

export interface CreateSendLinkInput {
  label: string;
  /** Optional plaintext password. Hashed before storage; never persisted raw. */
  password?: string | null;
  /** Optional positive integer cap on completed recipient downloads. */
  maxDownloads?: number | null;
  /** Optional expiry as unix epoch seconds, UTC. */
  expiresAt?: number | null;
}

export function createSendLinksModule(db: Db): SendLinksModule {
  const codeExists = async (code: string): Promise<boolean> => {
    const row = db.select({ id: sendLinks.id }).from(sendLinks).where(eq(sendLinks.code, code)).get();
    return Boolean(row);
  };

  return {
    async create(input) {
      // Mirror `receive-links.create`'s validation: trim, non-empty, capped.
      const trimmedLabel = input.label.trim();
      if (trimmedLabel.length === 0) {
        throw new Error('label_required');
      }
      if (trimmedLabel.length > 256) {
        throw new Error('label_too_long');
      }

      // `maxDownloads`: a positive integer or null. Mirrors `max_uploads`
      // validation on the receive side — 0/negative/non-integer is a typo,
      // not "unlimited".
      let maxDownloads: number | null = null;
      if (input.maxDownloads !== undefined && input.maxDownloads !== null) {
        if (!Number.isInteger(input.maxDownloads) || input.maxDownloads < 1) {
          throw new Error('invalid_max_downloads');
        }
        maxDownloads = input.maxDownloads;
      }

      // `expiresAt`: unix epoch seconds, UTC. Same shape as the receive side —
      // any integer is accepted, including already-past values for testing the
      // `expired` branch deterministically.
      let expiresAt: number | null = null;
      if (input.expiresAt !== undefined && input.expiresAt !== null) {
        if (!Number.isInteger(input.expiresAt)) {
          throw new Error('invalid_expires_at');
        }
        expiresAt = input.expiresAt;
      }

      // Password (optional). Hashed with Better Auth's scrypt helper — same
      // primitive the receive side uses, same primitive the admin login uses.
      let passwordHash: string | null = null;
      if (input.password !== undefined && input.password !== null && input.password.length > 0) {
        passwordHash = await hashPassword(input.password);
      }

      const code = await mintUniqueCode(codeExists);
      const id = randomUUID();
      const createdAt = Math.floor(Date.now() / 1000);

      db.insert(sendLinks)
        .values({
          id,
          code,
          label: trimmedLabel,
          passwordHash,
          maxDownloads,
          downloadCount: 0,
          expiresAt,
          status: 'active',
          createdAt,
        })
        .run();

      return {
        id,
        code,
        label: trimmedLabel,
        passwordHash,
        maxDownloads,
        downloadCount: 0,
        expiresAt,
        status: 'active',
        createdAt,
      };
    },

    async getByCode(code) {
      const normalized = normalizeCode(code);
      const row = db.select().from(sendLinks).where(eq(sendLinks.code, normalized)).get();
      return row ? toSendLink(row) : null;
    },

    async getById(id) {
      const row = db.select().from(sendLinks).where(eq(sendLinks.id, id)).get();
      return row ? toSendLink(row) : null;
    },

    async list() {
      const rows = db
        .select()
        .from(sendLinks)
        .orderBy(sql`${sendLinks.createdAt} desc`)
        .all();
      return rows.map(toSendLink);
    },

    async remove(id) {
      const result = db.delete(sendLinks).where(eq(sendLinks.id, id)).run();
      return Number(result.changes) > 0;
    },

    async recordDownloadCount(linkId) {
      const row = db
        .select({ value: sendLinks.downloadCount })
        .from(sendLinks)
        .where(eq(sendLinks.id, linkId))
        .get();
      return row?.value ?? 0;
    },

    async recordFileCount(linkId) {
      const row = db
        .select({ value: sql<number>`count(*)` })
        .from(files)
        .where(eq(files.sendLinkId, linkId))
        .get();
      return row?.value ?? 0;
    },
  };
}

function toSendLink(row: typeof sendLinks.$inferSelect): SendLink {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    passwordHash: row.passwordHash,
    maxDownloads: row.maxDownloads,
    downloadCount: row.downloadCount,
    expiresAt: row.expiresAt,
    status: row.status,
    createdAt: row.createdAt,
  };
}
