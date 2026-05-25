import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

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

      const code = await mintUniqueCode(codeExists);
      const id = randomUUID();
      const createdAt = Math.floor(Date.now() / 1000);

      db.insert(receiveLinks)
        .values({
          id,
          code,
          label: trimmedLabel,
          passwordHash: null,
          maxUploads: null,
          expiresAt: null,
          status: 'active',
          createdAt,
        })
        .run();

      return {
        id,
        code,
        label: trimmedLabel,
        passwordHash: null,
        maxUploads: null,
        expiresAt: null,
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
