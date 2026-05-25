import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

// ---------------------------------------------------------------------------
// Domain tables.
//
// Style conventions for these tables (different from the Better Auth tables
// above, which must match Better Auth's field-name strings exactly):
//
//   - snake_case column names. The Drizzle field name is camelCase; the SQL
//     column name (the `text(...)` / `integer(...)` argument) is snake_case.
//   - Timestamps are unix epoch seconds, stored as plain `integer`. Always
//     UTC. The PRD calls this out explicitly. We do not use Drizzle's
//     `{ mode: 'timestamp' }` so consumers see raw numbers — easier to reason
//     about across module boundaries, easier to compare with `Date.now()/1000`.
//   - IDs are `crypto.randomUUID()` strings (RFC 4122 v4). Chosen for the
//     `randomUUID` being a Node built-in (no new dep), good collision
//     properties, and stable string representation. The same id strategy is
//     used for `receive_links`, `upload_tickets`, and `files` so downstream
//     code can rely on a single shape.
//   - Public-facing `code` columns are short URL-safe codes minted by
//     `links/code-generator.ts` (Crockford base32, 8 chars by default).
// ---------------------------------------------------------------------------

/**
 * A receive link — an admin-created URL anyone can open to upload one or more
 * files. Policy columns (`passwordHash`, `maxUploads`, `expiresAt`) are
 * nullable; the #5 tracer only writes `null` for all three. #6 fills them in
 * via the same schema.
 */
export const receiveLinks = sqliteTable('receive_links', {
  id: text('id').primaryKey(),
  /** Short URL-safe public code. Used in `/r/:code`. */
  code: text('code').notNull().unique(),
  /** Admin-facing label, e.g. "Photos from Bob". */
  label: text('label').notNull(),
  /**
   * Hashed link password. Null = no password.
   *
   * Algorithm: scrypt (via `@better-auth/utils/password`). Format is
   * `<salt-hex>:<key-hex>`. Reusing Better Auth's hash primitive avoids a
   * second password-hashing library in the dependency surface — the admin
   * login password is hashed the same way.
   */
  passwordHash: text('password_hash'),
  /** Quota in number of completed uploads. Null = unlimited. */
  maxUploads: integer('max_uploads'),
  /** Expiry as unix epoch seconds, UTC. Null = never. */
  expiresAt: integer('expires_at'),
  /** Lifecycle flag. Disabled links 404 from the public surface. */
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at').notNull(),
});

/**
 * An upload ticket — short-lived authorization to PUT one object into the
 * bucket. The same primitive serves both the inbound direction (`intent =
 * 'receive'`, FK to `receive_links`) and, in #8, the outbound direction
 * (`intent = 'send'`, FK to `send_links`). #5 only writes receive tickets.
 *
 * Why a `CHECK` on `intent` plus a TS-side enum: the enum gives us compile-time
 * exhaustiveness in the policy/ticket modules; the CHECK constraint is the
 * last line of defence against a stray raw SQL write inserting an unknown
 * value (the kind of bug that's invisible until #8 lands).
 */
export const uploadTickets = sqliteTable(
  'upload_tickets',
  {
    id: text('id').primaryKey(),
    intent: text('intent', { enum: ['receive', 'send'] }).notNull(),
    /**
     * FK to receive_links; non-null when `intent = 'receive'`. ON DELETE
     * CASCADE: deleting a receive link wipes its pending/failed tickets
     * because they reference a link that no longer exists. Completed tickets
     * have already produced a `file` row whose lifecycle is independent
     * (see `files.receive_link_id` below).
     */
    receiveLinkId: text('receive_link_id').references(() => receiveLinks.id, {
      onDelete: 'cascade',
    }),
    /**
     * Forward-compat for #8 send links. No FK yet — the `send_links` table
     * doesn't exist until that slice. A column with no FK keeps the schema
     * stable so #8 only has to add the table and (optionally) the FK.
     */
    sendLinkId: text('send_link_id'),
    /** Bucket key the ticket was minted for. Stable, opaque. */
    s3Key: text('s3_key').notNull(),
    /** Filename the uploader claimed. Echoed back on download. */
    filename: text('filename').notNull(),
    /** Content type the uploader claimed; signed into the presigned PUT. */
    contentType: text('content_type').notNull(),
    /** Client-claimed size in bytes. Null when unknown. */
    sizeHint: integer('size_hint'),
    status: text('status', { enum: ['pending', 'completed', 'failed', 'expired'] })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => ({
    // Hard-stop in SQL even though the Drizzle enum keeps TS honest. Belt and
    // braces for the day a raw SQL write or migration data-fix forgets.
    intentCheck: check('upload_tickets_intent_check', sql`${t.intent} in ('receive', 'send')`),
  }),
);

/**
 * A file — a record of bytes that exist in the bucket. Created only after
 * `headObject` confirms the object actually landed. The displayed filename
 * comes from this row, not from the bucket key.
 *
 * `receive_link_id` is `ON DELETE SET NULL` (deliberate, the opposite of the
 * ticket cascade): deleting the link should NOT delete the historical record
 * that a file was received. The admin can still see and clean up the file row
 * even after the link is gone. Same intent for the future `send_link_id`.
 */
export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  s3Key: text('s3_key').notNull(),
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at').notNull(),
  receiveLinkId: text('receive_link_id').references(() => receiveLinks.id, {
    onDelete: 'set null',
  }),
  /** Forward-compat for #8. No FK yet — same reasoning as upload_tickets.send_link_id. */
  sendLinkId: text('send_link_id'),
});
