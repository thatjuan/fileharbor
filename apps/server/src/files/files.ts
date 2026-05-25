import { and, desc, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { files } from '../db/schema.js';

/**
 * CRUD over `files`. Files are created exclusively by `upload-tickets.finalize`
 * after `headObject` confirms the bytes landed — there is no other path to
 * insert a row here. Deletion is #7's territory.
 */

export interface FileRecord {
  id: string;
  s3Key: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  receiveLinkId: string | null;
  sendLinkId: string | null;
}

export interface CreateFileInput {
  id: string;
  s3Key: string;
  filename: string;
  contentType: string;
  size: number;
  receiveLinkId: string | null;
  sendLinkId: string | null;
}

export interface FilesModule {
  create(input: CreateFileInput): Promise<FileRecord>;
  getById(id: string): Promise<FileRecord | null>;
  listForReceiveLink(linkId: string): Promise<FileRecord[]>;
  /**
   * Files bound to a send link (i.e. completed admin uploads). Newest first.
   * Mirror of `listForReceiveLink`. Used by the admin send-link detail page,
   * the public send-link metadata endpoint, and the `finalize` idempotency
   * branch for send-intent tickets.
   */
  listForSendLink(linkId: string): Promise<FileRecord[]>;
  /**
   * Delete the DB row for a file by id. Returns `true` when a row was
   * removed. The S3 object is the caller's responsibility — #7's admin
   * delete handler deletes the object first, then calls this.
   */
  deleteById(id: string): Promise<boolean>;
}

export function createFilesModule(db: Db): FilesModule {
  return {
    async create(input) {
      const createdAt = Math.floor(Date.now() / 1000);
      db.insert(files)
        .values({
          id: input.id,
          s3Key: input.s3Key,
          filename: input.filename,
          contentType: input.contentType,
          size: input.size,
          createdAt,
          receiveLinkId: input.receiveLinkId,
          sendLinkId: input.sendLinkId,
        })
        .run();
      return {
        id: input.id,
        s3Key: input.s3Key,
        filename: input.filename,
        contentType: input.contentType,
        size: input.size,
        createdAt,
        receiveLinkId: input.receiveLinkId,
        sendLinkId: input.sendLinkId,
      };
    },

    async getById(id) {
      const row = db.select().from(files).where(eq(files.id, id)).get();
      return row ? toFileRecord(row) : null;
    },

    async listForReceiveLink(linkId) {
      const rows = db
        .select()
        .from(files)
        .where(and(eq(files.receiveLinkId, linkId)))
        .orderBy(desc(files.createdAt))
        .all();
      return rows.map(toFileRecord);
    },

    async listForSendLink(linkId) {
      const rows = db
        .select()
        .from(files)
        .where(eq(files.sendLinkId, linkId))
        .orderBy(desc(files.createdAt))
        .all();
      return rows.map(toFileRecord);
    },

    async deleteById(id) {
      const result = db.delete(files).where(eq(files.id, id)).run();
      return Number(result.changes) > 0;
    },
  };
}

function toFileRecord(row: typeof files.$inferSelect): FileRecord {
  return {
    id: row.id,
    s3Key: row.s3Key,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    createdAt: row.createdAt,
    receiveLinkId: row.receiveLinkId,
    sendLinkId: row.sendLinkId,
  };
}
