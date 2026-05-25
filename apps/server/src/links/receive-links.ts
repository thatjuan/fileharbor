import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { hashPassword } from '@better-auth/utils/password';

import type { Db } from '../db/client.js';
import { files, receiveLinks } from '../db/schema.js';
import { mintUniqueCode, normalizeCode } from './code-generator.js';

/**
 * CRUD over `receive_links` plus the aggregate `recordUploadCount` view.
 *
 * For #5 only `create`, `getByCode`, `getById`, and `list` are wired to admin
 * surfaces; the rest of the module exists so #6 and #7 can wire them without
 * touching this file's shape.
 */

export interface ReceiveLink {
  id: string;
  code: string;
  label: string;
  passwordHash: string | null;
  maxUploads: number | null;
  /** Unix epoch seconds, UTC. */
  expiresAt: number | null;
  status: 'active' | 'disabled';
  createdAt: number;
}

export interface ReceiveLinksModule {
  create(input: CreateReceiveLinkInput): Promise<ReceiveLink>;
  getByCode(code: string): Promise<ReceiveLink | null>;
  getById(id: string): Promise<ReceiveLink | null>;
  list(): Promise<ReceiveLink[]>;
  /**
   * Count of files attached to this link (i.e. completed uploads). Computed
   * on demand from `files` rather than denormalised on the link row; #5 has
   * one place that needs it and joining is cheap. If a later slice surfaces
   * this on every list response we'll consider caching.
   */
  recordUploadCount(linkId: string): Promise<number>;
}

export interface CreateReceiveLinkInput {
  label: string;
  /** Optional plaintext password. Hashed before storage; never persisted raw. */
  password?: string | null;
  /** Optional positive integer cap on completed uploads. */
  maxUploads?: number | null;
  /** Optional expiry as unix epoch seconds, UTC. */
  expiresAt?: number | null;
}

export function createReceiveLinksModule(db: Db): ReceiveLinksModule {
  const codeExists = async (code: string): Promise<boolean> => {
    const row = db
      .select({ id: receiveLinks.id })
      .from(receiveLinks)
      .where(eq(receiveLinks.code, code))
      .get();
    return Boolean(row);
  };

  return {
    async create(input) {
      const trimmedLabel = input.label.trim();
      if (trimmedLabel.length === 0) {
        throw new Error('label_required');
      }
      if (trimmedLabel.length > 256) {
        throw new Error('label_too_long');
      }

      // `maxUploads`: a positive integer or null. Treat 0 / negative / non-integer
      // as user error — silently coercing them would let a typo create a link
      // that can never accept an upload.
      let maxUploads: number | null = null;
      if (input.maxUploads !== undefined && input.maxUploads !== null) {
        if (!Number.isInteger(input.maxUploads) || input.maxUploads < 1) {
          throw new Error('invalid_max_uploads');
        }
        maxUploads = input.maxUploads;
      }

      // `expiresAt`: unix epoch seconds, UTC. We accept any integer the caller
      // hands us (incl. already-past values, useful for "instant disable" and
      // for testing the `expired` branch deterministically). The policy module
      // makes the same comparison either way.
      let expiresAt: number | null = null;
      if (input.expiresAt !== undefined && input.expiresAt !== null) {
        if (!Number.isInteger(input.expiresAt)) {
          throw new Error('invalid_expires_at');
        }
        expiresAt = input.expiresAt;
      }

      // Password (optional). Hashed via Better Auth's own scrypt helper so we
      // reuse the same primitive that hashes the admin login password — no new
      // hash library to audit. Empty/whitespace-only input is treated as "no
      // password" so a casual operator doesn't accidentally lock themselves out
      // with a stray space.
      let passwordHash: string | null = null;
      if (input.password !== undefined && input.password !== null) {
        const trimmedPassword = input.password;
        if (trimmedPassword.length > 0) {
          passwordHash = await hashPassword(trimmedPassword);
        }
      }

      const code = await mintUniqueCode(codeExists);
      const id = randomUUID();
      const createdAt = Math.floor(Date.now() / 1000);

      db.insert(receiveLinks)
        .values({
          id,
          code,
          label: trimmedLabel,
          passwordHash,
          maxUploads,
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
        maxUploads,
        expiresAt,
        status: 'active',
        createdAt,
      };
    },

    async getByCode(code) {
      const normalized = normalizeCode(code);
      const row = db.select().from(receiveLinks).where(eq(receiveLinks.code, normalized)).get();
      return row ? toReceiveLink(row) : null;
    },

    async getById(id) {
      const row = db.select().from(receiveLinks).where(eq(receiveLinks.id, id)).get();
      return row ? toReceiveLink(row) : null;
    },

    async list() {
      const rows = db
        .select()
        .from(receiveLinks)
        .orderBy(sql`${receiveLinks.createdAt} desc`)
        .all();
      return rows.map(toReceiveLink);
    },

    async recordUploadCount(linkId) {
      const row = db
        .select({ value: sql<number>`count(*)` })
        .from(files)
        .where(and(eq(files.receiveLinkId, linkId), isNotNull(files.receiveLinkId)))
        .get();
      return row?.value ?? 0;
    },
  };
}

function toReceiveLink(row: typeof receiveLinks.$inferSelect): ReceiveLink {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    passwordHash: row.passwordHash,
    maxUploads: row.maxUploads,
    expiresAt: row.expiresAt,
    status: row.status,
    createdAt: row.createdAt,
  };
}
