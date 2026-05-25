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
 * A send link — an admin-created URL anyone can open to download the file(s)
 * the admin packaged into the link. Lifecycle mirrors `receive_links` but the
 * counter direction is reversed: `maxDownloads` caps how many recipient GETs
 * are allowed, and `downloadCount` is the running tally. Both columns exist
 * already at the schema level so #11 (policy: password/quota/expiry on send
 * links) can wire them without another migration. This slice (#8) only writes
 * the row with `passwordHash`/`maxDownloads`/`expiresAt` all null.
 */
export const sendLinks = sqliteTable('send_links', {
  id: text('id').primaryKey(),
  /** Short URL-safe public code. Used in `/s/:code`. */
  code: text('code').notNull().unique(),
  /** Admin-facing label, e.g. "Q3 audit pack". */
  label: text('label').notNull(),
  /** Hashed link password. Null = no password. Algorithm matches receive links. */
  passwordHash: text('password_hash'),
  /** Quota in number of recipient downloads. Null = unlimited. */
  maxDownloads: integer('max_downloads'),
  /**
   * Running count of completed downloads. Pre-baked so the policy module only
   * has to compare two integers; the decrement-on-confirmation logic lands in
   * #11 with `download-tickets.confirm`. Stays at 0 in this slice.
   */
  downloadCount: integer('download_count').notNull().default(0),
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
 * 'receive'`, FK to `receive_links`) and the outbound direction (`intent =
 * 'send'`, FK to `send_links`) — see issue #8. Which FK is non-null is driven
 * by the `intent` enum; the other side is null.
 *
 * Why a `CHECK` on `intent` plus a TS-side enum: the enum gives us compile-time
 * exhaustiveness in the policy/ticket modules; the CHECK constraint is the
 * last line of defence against a stray raw SQL write inserting an unknown
 * value.
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
     * FK to send_links; non-null when `intent = 'send'`. Same cascade
     * rationale as the receive side.
     */
    sendLinkId: text('send_link_id').references(() => sendLinks.id, {
      onDelete: 'cascade',
    }),
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
  /**
   * FK to send_links with ON DELETE SET NULL — same intent as
   * `receive_link_id`: deleting the link should not destroy the historical
   * file row. (Send-link delete lands in #12.)
   */
  sendLinkId: text('send_link_id').references(() => sendLinks.id, {
    onDelete: 'set null',
  }),
});

/**
 * A download ticket — short-lived authorization for one recipient GET against
 * the bucket. Minted by `download-tickets.createForSendLink` after the link
 * policy passes; the presigned URL is returned inline and persisted for the
 * audit trail. This slice (#8) doesn't read the persisted URL back — #11 adds
 * `confirm(ticketId)` which will close out the ticket and decrement
 * `send_links.download_count`.
 */
/**
 * In-app notifications surfaced in the admin dashboard. A row is written by
 * `upload-tickets.finalize` on every successful inbound (receive-intent)
 * upload; admin send-link uploads do NOT generate notifications (PRD).
 *
 * `kind` is a discriminator string so future event types (link expired, quota
 * reached, ...) can land here without another migration. v1 only writes
 * `upload_received`. `payload` is JSON-encoded with the discriminator-specific
 * fields: for `upload_received` that's
 * `{ receiveLinkId, receiveLinkLabel, fileId, filename, size }`.
 *
 * `read_at` is nullable so the unread set is a cheap `where read_at IS NULL`
 * filter. We deliberately do NOT cascade-delete with the receive link or file
 * — a notification is a historical event; deleting the underlying file
 * shouldn't erase the record that an upload happened. The dashboard tolerates
 * dangling ids by surfacing the payload's frozen-at-write-time `filename` /
 * `receiveLinkLabel`.
 */
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  /** JSON-encoded payload. Shape is `kind`-dependent. */
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
  readAt: integer('read_at'),
});

export const downloadTickets = sqliteTable('download_tickets', {
  id: text('id').primaryKey(),
  sendLinkId: text('send_link_id')
    .notNull()
    .references(() => sendLinks.id, { onDelete: 'cascade' }),
  fileId: text('file_id')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  /** Bucket key the URL is signed against. Mirrors the file's key. */
  s3Key: text('s3_key').notNull(),
  /** Filename surfaced to the recipient via response-content-disposition. */
  filename: text('filename').notNull(),
  /**
   * The presigned GET. Goes stale within minutes — persisted for audit, not
   * for re-use. Never returned by any GET endpoint.
   */
  presignedGetUrl: text('presigned_get_url').notNull(),
  expiresAt: integer('expires_at').notNull(),
  status: text('status', { enum: ['pending', 'completed', 'failed', 'expired'] })
    .notNull()
    .default('pending'),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
});
