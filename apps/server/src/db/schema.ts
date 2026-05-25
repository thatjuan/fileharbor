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

// ---------------------------------------------------------------------------
// Better Auth tables.
//
// Column names are camelCase to match Better Auth's default `fieldName`s — the
// Drizzle adapter reads/writes these columns by the exact field-name strings
// Better Auth declares in `@better-auth/core/db/get-tables.mjs`. Keeping the
// column names camelCase avoids configuring a per-field name override for
// every column.
//
// Dates use `integer({ mode: 'timestamp' })`: Better Auth hands the adapter
// `Date` objects; drizzle stores them as unix epoch seconds and rehydrates
// them as `Date`s on read. The adapter then re-wraps with `new Date(data)` for
// belt-and-braces.
// ---------------------------------------------------------------------------

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  // Added by the `username` plugin. Unique + nullable so legacy/seeded rows
  // can coexist with username-bearing rows; in this single-user app every
  // user row will have one.
  username: text('username').unique(),
  displayUsername: text('displayUsername'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
});
