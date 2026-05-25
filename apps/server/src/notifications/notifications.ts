import { randomUUID } from 'node:crypto';
import { and, desc, inArray, isNull, sql } from 'drizzle-orm';
// `sql` retained for the count(*) literal in `unreadCount`.

import type { Db } from '../db/client.js';
import { notifications } from '../db/schema.js';

/**
 * In-app notifications facade. v1 surfaces only one kind, `upload_received`,
 * written from `upload-tickets.finalize` after a successful inbound upload.
 *
 * `payload` is JSON in the row; the module parses it on read into a typed
 * shape, with a guarded fallback for forward-compat (a future kind we don't
 * yet know about should still list, just with a passthrough payload).
 *
 * Read state lives entirely in `read_at`: null = unread, otherwise the unix
 * epoch seconds we marked it. The unread badge is `count(*) where read_at is
 * null`.
 */

export interface UploadReceivedPayload {
  receiveLinkId: string;
  receiveLinkLabel: string;
  fileId: string;
  filename: string;
  size: number;
}

export interface NotificationRecord {
  id: string;
  kind: string;
  /** Parsed JSON. `unknown` rather than `Record<string, unknown>` so callers
   * narrow before touching fields — keeps `noUncheckedIndexedAccess` honest. */
  payload: unknown;
  createdAt: number;
  readAt: number | null;
}

export interface ListInput {
  limit?: number;
  unreadOnly?: boolean;
}

export interface NotificationsModule {
  /**
   * Insert a single notification. Returns the new id. Caller wraps in
   * try/catch — notifications are a downstream effect, never a hard
   * dependency of the upstream event (e.g. upload finalize).
   */
  record(kind: 'upload_received', payload: UploadReceivedPayload): Promise<string>;
  list(input?: ListInput): Promise<NotificationRecord[]>;
  unreadCount(): Promise<number>;
  /**
   * Mark the given ids as read. Only rows currently unread are touched, so
   * the returned count reflects an actual state transition (not "rows
   * matched"). Empty `ids` is a no-op that returns 0 — guards against
   * Drizzle's `inArray([])` generating invalid SQL.
   */
  markRead(ids: string[]): Promise<number>;
  markAllRead(): Promise<number>;
}

export function createNotificationsModule(db: Db): NotificationsModule {
  return {
    async record(kind, payload) {
      const id = randomUUID();
      const createdAt = Math.floor(Date.now() / 1000);
      db.insert(notifications)
        .values({
          id,
          kind,
          payload: JSON.stringify(payload),
          createdAt,
          readAt: null,
        })
        .run();
      return id;
    },

    async list(input) {
      const limit = clampLimit(input?.limit);
      // Build the where clause first; drizzle's chain order is
      // select → from → where → orderBy → limit. Splitting the two branches
      // keeps each chain a complete, well-typed builder rather than mutating
      // a half-built query.
      const rows = input?.unreadOnly
        ? db
            .select()
            .from(notifications)
            .where(isNull(notifications.readAt))
            .orderBy(desc(notifications.createdAt))
            .limit(limit)
            .all()
        : db
            .select()
            .from(notifications)
            .orderBy(desc(notifications.createdAt))
            .limit(limit)
            .all();
      return rows.map(toRecord);
    },

    async unreadCount() {
      const row = db
        .select({ count: sql<number>`count(*)` })
        .from(notifications)
        .where(isNull(notifications.readAt))
        .get();
      return row?.count ?? 0;
    },

    async markRead(ids) {
      // Empty list is a no-op. `inArray(col, [])` generates `col in ()` which
      // SQLite rejects as a syntax error — guard at the boundary.
      if (ids.length === 0) return 0;
      const now = Math.floor(Date.now() / 1000);
      // Only flip rows that are still unread so the returned change count is
      // "rows that actually transitioned" rather than "rows matched". A
      // double-mark-read returning N would lie to the UI about how many new
      // items it just cleared.
      const result = db
        .update(notifications)
        .set({ readAt: now })
        .where(and(inArray(notifications.id, ids), isNull(notifications.readAt)))
        .run();
      return Number(result.changes);
    },

    async markAllRead() {
      const now = Math.floor(Date.now() / 1000);
      const result = db
        .update(notifications)
        .set({ readAt: now })
        .where(isNull(notifications.readAt))
        .run();
      return Number(result.changes);
    },
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return 50;
  if (!Number.isInteger(raw) || raw < 1) return 50;
  return Math.min(raw, 200);
}

function toRecord(row: typeof notifications.$inferSelect): NotificationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    // Pathological row — surface the raw string so the dashboard can render
    // *something* rather than blowing up the whole list.
    parsed = { raw: row.payload };
  }
  return {
    id: row.id,
    kind: row.kind,
    payload: parsed,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}
