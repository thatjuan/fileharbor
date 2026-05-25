import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Single-row table used as a sentinel that the schema bootstrap ran. Domain
 * tables (links, tickets, files, ...) land in later slices alongside their
 * modules; this table exists so the migration runner has something concrete to
 * apply on the first boot, which lets us demonstrate idempotency on the
 * second.
 */
export const systemMeta = sqliteTable('system_meta', {
  id: integer('id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});
