# Issue #37 — DB Schema & Lifecycle Plan (multipart upload v2)

Scope: schema extensions, migration 0006, ticket lifecycle state machine,
cascade policy, sweep extensions, and config surface for multipart upload
support. Backend-agnostic — the same shape covers both the S3 and local
storage backends.

Files referenced (absolute paths):
- `/Users/user/work/playground/fileharbor/apps/server/src/db/schema.ts`
- `/Users/user/work/playground/fileharbor/apps/server/src/db/client.ts`
- `/Users/user/work/playground/fileharbor/apps/server/drizzle/0000_even_living_mummy.sql` … `0005_rare_jimmy_woo.sql`
- `/Users/user/work/playground/fileharbor/apps/server/src/tickets/upload-tickets.ts`
- `/Users/user/work/playground/fileharbor/apps/server/src/tickets/sweep.ts`
- `/Users/user/work/playground/fileharbor/apps/server/src/tickets/download-tickets.ts`
- `/Users/user/work/playground/fileharbor/apps/server/src/links/receive-links.ts`
- `/Users/user/work/playground/fileharbor/apps/server/src/links/send-links.ts`
- `/Users/user/work/playground/fileharbor/apps/server/src/routes/public-upload-tickets.ts`
- `/Users/user/work/playground/fileharbor/apps/server/src/config.ts`
- `/Users/user/work/playground/fileharbor/apps/server/drizzle.config.ts`

---

## 1. `upload_tickets` extension

### 1.1 New columns

| SQL name (snake_case) | Drizzle field (camelCase) | Type | Nullable | Default | Notes |
|---|---|---|---|---|---|
| `protocol` | `protocol` | `text` | NOT NULL | `'single'` | Discriminator. CHECK `in ('single','multipart')` only enforced at the Drizzle enum layer (see §1.3). |
| `upload_id` | `uploadId` | `text` | NULL | NULL | S3 `UploadId` from `CreateMultipartUploadCommand`, or a ULID minted by the local backend. NULL when `protocol='single'`. |
| `part_size` | `partSize` | `integer` | NULL | NULL | Bytes per part. NULL for `single`. Pinned at init time; `complete` validates against it. |
| `expected_parts` | `expectedParts` | `integer` | NULL | NULL | Total parts the client committed to at init. `complete` requires exactly this count. |

Rationale for keeping `upload_id` / `part_size` / `expected_parts` nullable:
the single-PUT branch never sets them and we want one row shape across both
protocols — making them `NOT NULL DEFAULT 0` would mask "did init run?"
bugs and bloat the row for the dominant case. The discriminator `protocol`
plus null-or-not on `upload_id` keeps state explicit.

### 1.2 New status: `aborting`

Full status list (Drizzle enum on `uploadTickets.status`):

```
['pending', 'completed', 'failed', 'expired', 'aborting']
```

Semantics:
- `aborting` is a **transient, non-terminal** state. The ticket is in flight,
  the multipart session is being torn down at the storage layer, and we
  haven't observed the storage call succeed yet.
- The sweep's terminal-retention phase (`TERMINAL_STATUSES = ['expired',
  'failed', 'completed']` in `sweep.ts:81`) must remain unchanged — do NOT
  add `aborting` to it. An aborting row that lingers means the abort
  succeeded eventually and the row transitioned to `expired` (terminal), or
  the abort kept failing and we want it to keep retrying, not be GC'd.

`completed_at` is **not** set when entering `aborting`. It is set when the
row transitions to its terminal status (`expired` after successful abort,
or `failed` if we ever decide to give up). The sweep's phase-3 retention
query (`coalesce(completed_at, created_at)`) is unaffected: aborting rows
are excluded by status anyway, and on terminal transition the column is
populated.

### 1.3 SQL CHECK constraints — what the existing schema actually does

Verified against `schema.ts` and `0003_secret_angel.sql`:

- `upload_tickets` has **one** CHECK constraint, on `intent` only (line 227
  in schema.ts: `intentCheck`).
- `upload_tickets.status` is currently enforced **only at the Drizzle
  TS-enum layer** — there is no SQL CHECK on `status`. Same for
  `download_tickets.status`.

The task brief's claim that "the CHECK constraint approach matches
existing tables (it does — line 227 in schema.ts)" is referring to the
intent check, not a status check. So:

- Adding `'aborting'` to the Drizzle enum is sufficient. **No SQL CHECK
  migration is required.**
- Adding `'multipart'` to the new `protocol` column needs no CHECK either
  — the Drizzle enum (`text('protocol', { enum: ['single', 'multipart'] })`)
  is the single source of truth, matching the existing convention for
  `status`. We **could** add a CHECK for belt-and-braces parity with
  `intent`, but SQLite cannot `ALTER TABLE ADD CONSTRAINT` — adding it
  requires the full table-rebuild dance shown in
  `0003_secret_angel.sql:29-66` (`PRAGMA foreign_keys=OFF`, `CREATE TABLE
  __new_upload_tickets`, `INSERT … SELECT`, `DROP`, `RENAME`, `PRAGMA
  foreign_keys=ON`). Recommendation: **skip the CHECK** on `protocol` to
  keep 0006 a minimal `ADD COLUMN` migration. If we later want a status
  CHECK that covers the new `aborting` value as well, do both columns in
  one rebuild then.

### 1.4 Drizzle schema patch (illustrative)

```ts
export const uploadTickets = sqliteTable(
  'upload_tickets',
  {
    id: text('id').primaryKey(),
    intent: text('intent', { enum: ['receive', 'send'] }).notNull(),
    receiveLinkId: text('receive_link_id').references(() => receiveLinks.id, {
      onDelete: 'cascade',
    }),
    sendLinkId: text('send_link_id').references(() => sendLinks.id, {
      onDelete: 'cascade',
    }),
    s3Key: text('s3_key').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeHint: integer('size_hint'),
    status: text('status', {
      enum: ['pending', 'completed', 'failed', 'expired', 'aborting'],
    })
      .notNull()
      .default('pending'),
    // ---- new in 0006 ----
    protocol: text('protocol', { enum: ['single', 'multipart'] })
      .notNull()
      .default('single'),
    uploadId: text('upload_id'),
    partSize: integer('part_size'),
    expectedParts: integer('expected_parts'),
    // ---------------------
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (t) => ({
    intentCheck: check('upload_tickets_intent_check', sql`${t.intent} in ('receive', 'send')`),
    statusCreatedIdx: index('idx_upload_tickets_status_created').on(t.status, t.createdAt),
  }),
);
```

### 1.5 Existing-row safety

- All existing rows get `protocol='single'` from the column default. No
  data backfill needed.
- `upload_id`, `part_size`, `expected_parts` default to NULL — consistent
  with the discriminator (single rows never use them).
- The existing sweep query `WHERE status='pending' AND created_at < ?`
  still matches single-protocol rows as before. The new multipart phase
  (§6) additionally filters on `protocol='multipart'`, so existing rows
  are not touched by the new logic.

---

## 2. `upload_ticket_parts` table

### 2.1 Decision: per-part table over JSON column. Confirmed.

Reasons:
- **Per-part retry tracking** wants UPSERT semantics — a part that retries
  needs to overwrite its prior etag without locking the whole ticket row.
- **Complete semantics** want a SQL aggregate (`COUNT(*) = expected_parts`,
  `SELECT … ORDER BY part_number`) — both are awkward against a JSON blob.
- **Bounded query plans**: a composite UNIQUE index on
  `(upload_ticket_id, part_number)` gives O(log n) lookup and ordered scan.
  JSON would force a full row read + parse per part check.
- **Concurrency**: parallel part uploads writing into the same JSON column
  would serialise on a row-level lock and risk lost updates if the writer
  isn't fully transactional. Per-row inserts are independent.
- **Narrow ticket row**: keeps the hot `upload_tickets` row small (the
  policy/finalize code paths read it on every request).

### 2.2 Drizzle schema

```ts
export const uploadTicketParts = sqliteTable(
  'upload_ticket_parts',
  {
    id: text('id').primaryKey(), // randomUUID — same convention as other domain ids.
    uploadTicketId: text('upload_ticket_id')
      .notNull()
      .references(() => uploadTickets.id, { onDelete: 'cascade' }),
    /** 1..10000 per S3 rules. CHECK enforces the range in SQL. */
    partNumber: integer('part_number').notNull(),
    /** ETag returned by the backend on PUT-part. Null while in flight; set on success. */
    etag: text('etag'),
    /** Bytes for this specific part (last part may be < part_size). */
    size: integer('size'),
    /** Unix seconds when the part PUT succeeded. Null while in flight. */
    completedAt: integer('completed_at'),
  },
  (t) => ({
    partNumberCheck: check(
      'upload_ticket_parts_part_number_check',
      sql`${t.partNumber} >= 1 AND ${t.partNumber} <= 10000`,
    ),
    /**
     * Composite UNIQUE: at most one row per (ticket, part). Retries UPSERT
     * onto the same row instead of accumulating duplicates. Doubles as the
     * primary access path: complete reads `WHERE upload_ticket_id=? ORDER BY
     * part_number`, which the unique index satisfies directly.
     */
    ticketPartUnique: uniqueIndex('uq_upload_ticket_parts_ticket_part').on(
      t.uploadTicketId,
      t.partNumber,
    ),
  }),
);
```

### 2.3 No second index

The brief asks for "index for the sweep's enumerate-parts-for-orphan-cleanup
query". With FK `ON DELETE CASCADE` from parts → upload_tickets, parts
vanish automatically when the ticket row is deleted by the sweep's phase 3.
No orphan-enumerate query exists, and `abortMultipart` doesn't need the
parts list (S3's abort takes only the `UploadId`; local just `fs.rm`s the
parts directory). The composite unique index covers every real query:

- Init: bulk INSERT or no insert (parts created lazily on first PUT).
- Per-part retry/finish: `INSERT ... ON CONFLICT (upload_ticket_id, part_number) DO UPDATE`.
- Complete: `SELECT … WHERE upload_ticket_id=? ORDER BY part_number`.
- Sweep terminal-delete: parts cascade with the parent row.

Adding another index without a named query would be cargo. Skip it.

---

## 3. Migration 0006 — literal SQL

Filename: `apps/server/drizzle/0006_multipart_uploads.sql` (drizzle-kit
mints the slug; the exact word "multipart" should be in it — e.g.
`0006_<adjective>_<noun>.sql` per the existing naming pattern, but the
content is what matters).

Per `client.ts:23-24`, the migrator is
`drizzle-orm/better-sqlite3/migrator`. It records applied migrations in
`__drizzle_migrations` and skips them on re-run — every migration file is
itself idempotent **only** through that journal, not via `IF NOT EXISTS`
guards. Existing 0000-0005 do NOT use `IF NOT EXISTS`. We match that
convention.

```sql
ALTER TABLE `upload_tickets` ADD COLUMN `protocol` text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE `upload_tickets` ADD COLUMN `upload_id` text;--> statement-breakpoint
ALTER TABLE `upload_tickets` ADD COLUMN `part_size` integer;--> statement-breakpoint
ALTER TABLE `upload_tickets` ADD COLUMN `expected_parts` integer;--> statement-breakpoint
CREATE TABLE `upload_ticket_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`upload_ticket_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`etag` text,
	`size` integer,
	`completed_at` integer,
	FOREIGN KEY (`upload_ticket_id`) REFERENCES `upload_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "upload_ticket_parts_part_number_check" CHECK("upload_ticket_parts"."part_number" >= 1 AND "upload_ticket_parts"."part_number" <= 10000)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_upload_ticket_parts_ticket_part` ON `upload_ticket_parts` (`upload_ticket_id`,`part_number`);
```

Notes for the implementer (generate via `drizzle-kit generate`, do not
hand-author):
- `ALTER TABLE ADD COLUMN` is supported by SQLite without a table rebuild
  and is safe with WAL + `foreign_keys=ON` (pragmas from `client.ts:20-21`).
- The `protocol` column adds `DEFAULT 'single'` + `NOT NULL` together —
  SQLite back-fills existing rows with the default during ADD COLUMN.
- **No status-enum migration** — the schema enforces status via the
  Drizzle TS layer; widening the TS enum to include `'aborting'` requires
  no SQL change (see §1.3).
- Do not include `--> statement-breakpoint` markers when hand-editing;
  drizzle-kit emits them. Match the style of `0003_secret_angel.sql`.
- Also commit a fresh `drizzle/meta/0006_snapshot.json` and the appended
  `_journal.json` entry — `drizzle-kit generate` writes both atomically.

---

## 4. Lifecycle state machine

States: `pending`, `aborting`, `completed`, `failed`, `expired`.

### 4.1 Legal transitions

```
              ┌──────────────────────────────────────────────┐
              │                                              │
              │            (single & multipart)              │
              │  finalize  / completeMultipart ── success ──►│ completed (terminal)
              │                                              │
              │  finalize / completeMultipart ── head/parts ─│ failed    (terminal)
              │                                missing      │
              │                                              │
   pending ───┤  sweep ── createdAt < (presignTtl + grace) ─►│ expired   (terminal)
              │                                              │
              │  user abort  /  link-delete pre-hook  ──────►│ aborting  (transient)
              │                                              │
              └──────────────────────────────────────────────┘

   aborting ─── sweep ── abortMultipart succeeded ──────────► expired   (terminal)
   aborting ─── sweep ── abortMultipart still failing ──────► aborting  (idempotent retry)
```

No transition out of any terminal state. No `expired → anything`. No
`completed → aborting` (see §4.3 below).

### 4.2 Per-transition specification

| From | To | Trigger | Side effects |
|---|---|---|---|
| `pending` | `completed` | `finalize` (single) — `headObject` returns size | Create `files` row, write notification (receive intent only). |
| `pending` | `completed` | `completeMultipart` — `storage.completeMultipart` returns ETag, parts count matches `expected_parts` | Create `files` row, write notification (receive intent only). |
| `pending` | `failed` | `finalize` — `headObject` returns null | Set `completed_at = now`. Single only. |
| `pending` | `failed` | `completeMultipart` — missing parts, etag mismatch, protocol violation, or `storage.completeMultipart` raises | Set `completed_at = now`. Server SHOULD also call `abortMultipart` here (defence in depth) before flipping to `failed`. |
| `pending` | `expired` | Sweep phase 1 (single) — `createdAt < now - presignTtl - grace` | Set `completed_at = now`. Bulk UPDATE guarded by `status='pending'`. |
| `pending` | `aborting` | User cancel via abort route, OR link-delete pre-delete hook (§5) | No `completed_at` write. Set `WHERE status='pending'` so a racing complete that already won is preserved. |
| `aborting` | `expired` | Sweep phase 1.6 — `storage.abortMultipart` succeeded (or raised "already aborted") | Set `completed_at = now`. Set `WHERE status='aborting'`. |
| `aborting` | `aborting` | Sweep — `storage.abortMultipart` raised transient error | No DB write. Logged. Retried on next tick. |

### 4.3 Idempotency rules

- **Re-finalize on `completed`** is OK — existing behaviour in
  `upload-tickets.ts:268-279` returns the same `{ kind: 'completed', fileId }`.
  Multipart `completeMultipart` follows the same pattern.
- **Abort on `aborting`** is a no-op — the sweep already owns the
  transition; return success immediately. Surface as an explicit
  `{ kind: 'already_aborting' }` outcome so the client UI can stop the
  spinner.
- **Abort on `completed`** is **rejected** with
  `{ kind: 'already_completed' }`. The bytes are already published, the
  `files` row is live, and racing the abort would orphan the file row from
  a deleted bucket key.
- **Abort on `failed` / `expired`** is a no-op (`{ kind: 'already_terminal' }`).
  The presign / multipart session is already inert.
- **Abort on `pending` (single)** is allowed: there's no multipart session
  to tear down, so just flip directly to `expired` and (best-effort)
  `storage.deleteObject` in case the client already PUT the bytes.
  The `aborting` state is meaningful only for `protocol='multipart'`.
- **completeMultipart on `aborting`** is rejected — `aborting` is the
  guard exactly so that complete cannot race in. Return
  `{ kind: 'failed', reason: 'aborting' }`.

### 4.4 Concurrency — every guarded UPDATE

Every state transition MUST include the source status in the WHERE clause
so a concurrent transition cannot be silently overwritten. This mirrors
the pattern in `download-tickets.ts:135` and `sweep.ts:118`.

| Transition | WHERE guard |
|---|---|
| `pending → completed` (single) | `id=? AND status='pending'` |
| `pending → completed` (multipart) | `id=? AND status='pending' AND protocol='multipart'` |
| `pending → failed` | `id=? AND status='pending'` |
| `pending → expired` (sweep bulk) | `status='pending' AND created_at < ?` — already guarded. |
| `pending → expired` (multipart sweep) | `status='pending' AND protocol='multipart' AND created_at < ?` |
| `pending → aborting` | `id=? AND status='pending'` |
| `aborting → expired` | `id=? AND status='aborting'` |

The aborting-guard on `completeMultipart` is the load-bearing race fix: a
user clicking cancel while the last part is uploading flips
`pending → aborting`. If `completeMultipart` then arrives, its
`WHERE status='pending'` returns 0 rows changed → it surfaces a "no longer
pending" outcome → the client UI shows cancelled, not completed.

---

## 5. Cascade vs soft-delete decision — **Option B-inline**

### 5.1 The brief's "Option B" has an internal contradiction

The brief describes Option B as "enumerates in-flight multipart tickets,
**marks aborting and sweep handles**, THEN runs the existing CASCADE
delete." That is **incoherent**: CASCADE deletes the ticket row
immediately, so the sweep has nothing left to find — `aborting` is moot
the instant CASCADE fires. The coherent splits are:

- **B-inline**: pre-delete hook calls `storage.abortMultipart` **synchronously**
  for each in-flight multipart ticket, then runs the existing CASCADE
  delete. FK stays `ON DELETE CASCADE`. The aborting/sweep handoff is
  bypassed entirely on the link-delete path.
- **B-deferred**: pre-delete hook marks tickets `aborting`, then somehow
  prevents CASCADE from deleting them. The only way to do that is to
  change the FK from CASCADE to `SET NULL` (or RESTRICT) — at which point
  B-deferred is structurally identical to Option A.

So the real choice is between **A/B-deferred** (FK change, soft-delete via
status, sweep does the storage work) and **B-inline** (FK unchanged,
inline storage call in link-delete).

### 5.2 Recommend **B-inline**.

Justification:

1. **Smallest behavioural change to the existing schema**. The FK
   relationship and the existing sweep code path stay exactly as they are
   today; only the link-delete code paths in
   `receive-links.ts:remove` and `send-links.ts:remove` grow a pre-step.
2. **No new orphan class**. With A/B-deferred (`SET NULL`), the ticket
   row outlives its link with `receive_link_id=NULL` — every other
   query that joins or filters by link id then needs a `WHERE
   receive_link_id IS NOT NULL` guard, and the sweep has to enumerate
   orphaned-by-link aborting rows. That's a wider blast radius than the
   bug we're fixing.
3. **Immediate behaviour matches the acceptance criterion**: "Deleting
   the parent receive/send link while a multipart upload is in flight
   aborts the session promptly." Inline abort is "promptly" by construction;
   sweep-handled abort waits up to one `intervalSeconds` (default 60s).
4. **`abortMultipart` is fast and idempotent**. S3's
   `AbortMultipartUpload` is one round trip; local is `fs.rm`. The
   link-delete admin route blocking on this for the in-flight count of
   tickets (usually 0–few) is acceptable. Failures are logged but do not
   block the cascade — see §5.4.

The cost is a synchronous SDK call inside the link-delete handler. We
accept this trade-off because the admin link-delete is interactive and
already not a hot path.

### 5.3 Implementation sketch

In `receive-links.ts:remove(id)` and `send-links.ts:remove(id)`, before
`db.delete(receiveLinks)`:

```ts
// Pre-delete hook: abort any in-flight multipart sessions so the CASCADE
// that follows doesn't strand storage state. Single-protocol pending
// tickets don't need this — there's nothing to abort beyond letting the
// presigned URL expire naturally. (Bytes already PUT by a single
// uploader become unreachable because the bucket key prefix encodes the
// link id; sweep + ops are the remaining cleanup story for those.)
const inFlight = db
  .select({ id: uploadTickets.id, s3Key: uploadTickets.s3Key, uploadId: uploadTickets.uploadId })
  .from(uploadTickets)
  .where(
    and(
      eq(uploadTickets.receiveLinkId, id),
      eq(uploadTickets.status, 'pending'),
      eq(uploadTickets.protocol, 'multipart'),
    ),
  )
  .all();

for (const t of inFlight) {
  if (!t.uploadId) continue; // defensive — protocol=multipart implies non-null
  try {
    await storage.abortMultipart(t.s3Key, t.uploadId);
  } catch (err) {
    // Don't block link delete on storage failure. The sweep's
    // `aborting`-handling path doesn't apply here (we're bypassing the
    // aborting state on the link-delete fast path), so log + carry on.
    // The orphaned session will eventually be reaped by:
    //   - S3 lifecycle rule (`AbortIncompleteMultipartUpload` — operator-owned), or
    //   - local: nothing automatic, but parts dir is at known path and ops can rm.
    log.error('[receive-links.remove] abortMultipart failed; CASCADE proceeding', {
      ticketId: t.id, err,
    });
  }
}
// CASCADE handles the row deletion as before.
```

Symmetric block lives in `send-links.ts:remove`.

### 5.4 Failure mode

If `storage.abortMultipart` keeps failing AND we still proceed with
CASCADE, we have orphaned a multipart session. This is the same failure
mode that exists today for any single-PUT ticket whose bytes were already
uploaded — we accept it, log it loudly, and document the README ops
note (per the issue's README requirement) that operators should configure
S3 lifecycle `AbortIncompleteMultipartUpload` as belt-and-braces.

---

## 6. Sweep changes

Add to `apps/server/src/tickets/sweep.ts`. New phases are inserted between
the current phase 1 and phase 2 (single-pending expiry) and the current
phase 3 (terminal delete). The terminal-delete phase **does not change** —
once an aborted multipart row reaches `expired`, it's reaped by the
existing retention logic on the same retention clock as everything else.

### 6.1 New `SweepCounters` field

```ts
export interface SweepCounters {
  expiredUploadTickets: number;
  expiredDownloadTickets: number;
  deletedUploadTickets: number;
  deletedDownloadTickets: number;
  /** Multipart sessions for which abortMultipart succeeded this pass. */
  abortedMultipartUploads: number;
}
```

### 6.2 Phase 1.5 — TTL-expire multipart sessions

Multipart sessions need a longer TTL than single-PUT presigned URLs because
parts upload over many minutes. Use `STORAGE_MULTIPART_TTL_SECONDS` (§7).

```ts
// --- Phase 1.5: TTL-expire multipart pending sessions ------------------
// One-shot: mark 'aborting' (race-guarded), then immediately call
// storage.abortMultipart, then mark 'expired'. Per-row, not bulk, because
// each row needs an SDK / fs side effect. Bulk UPDATE+side-effect would
// risk skipping the abort if the process crashes between UPDATE and the
// SDK call — splitting into aborting → side-effect → expired keeps the
// crash-resume path correct (Phase 1.6 picks up stuck-in-aborting rows).
try {
  const multipartCutoff = nowSeconds - multipartTtlSeconds;
  const candidates = db
    .select({ id: uploadTickets.id, s3Key: uploadTickets.s3Key, uploadId: uploadTickets.uploadId })
    .from(uploadTickets)
    .where(
      and(
        eq(uploadTickets.status, 'pending'),
        eq(uploadTickets.protocol, 'multipart'),
        lt(uploadTickets.createdAt, multipartCutoff),
      ),
    )
    .all();

  for (const row of candidates) {
    const flipped = db
      .update(uploadTickets)
      .set({ status: 'aborting' })
      .where(and(eq(uploadTickets.id, row.id), eq(uploadTickets.status, 'pending')))
      .run();
    if (Number(flipped.changes) === 0) continue; // raced with finalize / user-abort.
    // Fall through into Phase 1.6 logic for this row by deferring; or
    // perform the abort + expire inline here (preferred — same pass).
    if (await tryAbort(row)) {
      const t = db
        .update(uploadTickets)
        .set({ status: 'expired', completedAt: nowSeconds })
        .where(and(eq(uploadTickets.id, row.id), eq(uploadTickets.status, 'aborting')))
        .run();
      if (Number(t.changes) > 0) counters.abortedMultipartUploads += 1;
    }
  }
} catch (err) {
  log.error('[ticket-sweep] phase 1.5 multipart TTL abort failed', err);
}
```

### 6.3 Phase 1.6 — sweep stuck-in-aborting

Catches three cases:
- User-cancel that flipped `pending → aborting` but the route handler
  delegated the actual abort to the sweep.
- Process crashed between the `pending → aborting` write in Phase 1.5
  and the `aborting → expired` write.
- Previous tick's `abortMultipart` raised transient error; we retry.

```ts
try {
  const stuck = db
    .select({ id: uploadTickets.id, s3Key: uploadTickets.s3Key, uploadId: uploadTickets.uploadId })
    .from(uploadTickets)
    .where(eq(uploadTickets.status, 'aborting'))
    .all();
  for (const row of stuck) {
    if (await tryAbort(row)) {
      const t = db
        .update(uploadTickets)
        .set({ status: 'expired', completedAt: nowSeconds })
        .where(and(eq(uploadTickets.id, row.id), eq(uploadTickets.status, 'aborting')))
        .run();
      if (Number(t.changes) > 0) counters.abortedMultipartUploads += 1;
    }
    // else: stay in aborting; retried next tick. S3 abort is idempotent.
  }
} catch (err) {
  log.error('[ticket-sweep] phase 1.6 aborting drain failed', err);
}
```

`tryAbort` is a small helper that calls `storage.abortMultipart(key,
uploadId)`, returns true on success or "session not found" (idempotent),
false on transient failure (logged). A row that fails to abort forever
stays in `aborting` and the sweep keeps trying — that is intentional, and
acceptable because S3's `AbortMultipartUpload` is idempotent + cheap. If
operators need a hard cap we can later add an `attempts` column; deferred
for v2.

### 6.4 Race-safety summary

- `aborting` is the load-bearing race guard: any caller's
  `completeMultipart` writes `WHERE status='pending'` and fails fast if
  the sweep / cancel route already flipped to `aborting`.
- The `aborting → expired` write is `WHERE status='aborting'`, so a
  concurrent "manual force-complete" wouldn't accidentally re-expire a
  completed row.
- Phase 1's single-upload bulk UPDATE is unchanged. It already filters
  `WHERE status='pending'`, so it correctly skips rows in
  `aborting` / `completed` / `failed` / `expired`.

### 6.5 Index usage

The existing `idx_upload_tickets_status_created` (status, created_at)
covers both the existing pending-expiry query and the new
`status='pending' AND protocol='multipart' AND created_at < ?` query.
SQLite's planner uses the leading `status` to range-scan, then applies the
`protocol` filter as a residual. Multipart pending rows are a small
subset of pending rows, so this is fine — no new index. Phase 1.6's
`status='aborting'` query is also covered by the leading-status part of
the same index. Reconfirm with `EXPLAIN QUERY PLAN` during implementation
but do not pre-add.

### 6.6 `STORAGE_MULTIPART_TTL_SECONDS` plumbed via `TicketSweeperDeps`

Add to `TicketSweeperDeps`:

```ts
export interface TicketSweeperDeps {
  // ...existing fields...
  storage: StorageProvider;          // new — needed for abortMultipart
  multipartTtlSeconds: number;        // new — see §7
}
```

The DI wiring already passes deps from `loadConfig()` at boot; thread the
new field through.

---

## 7. Config — `STORAGE_MULTIPART_TTL_SECONDS`

### 7.1 Placement

The TTL applies equally to both backends (the multipart-session lifetime
is a property of the upload session, not the storage shape). Two clean
options:

- **(a)** Add to both `S3StorageConfig` and `LocalStorageConfig` in the
  discriminated union — symmetric with `presignTtlSeconds`.
- **(b)** Add to a new sibling block `StorageConfig.multipart` outside the
  union, since both branches need identical defaults / validation.

Recommendation: **(a)** — keep it on the discriminant arms next to
`presignTtlSeconds`. The duplication is two lines per branch and matches
the existing style.

```ts
export interface S3StorageConfig {
  backend: 's3';
  // ...existing...
  presignTtlSeconds: number;
  multipartTtlSeconds: number; // new
}
export interface LocalStorageConfig {
  backend: 'local';
  // ...existing...
  presignTtlSeconds: number;
  multipartTtlSeconds: number; // new
}
```

### 7.2 Default and bounds

- Default: `2 * 3600` (2 hours) — matches the issue.
- Reuse `parsePresignTtl`'s shape: positive integer, ≤ `7 * 24 * 3600`
  (7 days). Rename or split the helper as needed; the validation logic
  is identical. Cleanest: extract a generic `parseTtlSeconds(raw,
  varName, fallback, max)` and call it from both `parsePresignTtl` and
  the new multipart parse.

```ts
function parseMultipartTtl(raw: string | undefined): number {
  return parseTtlSeconds(raw, 'STORAGE_MULTIPART_TTL_SECONDS', 2 * 3600, 7 * 24 * 3600);
}
```

Resolved in both `resolveS3StorageConfig` and `resolveLocalStorageConfig`
from `env.STORAGE_MULTIPART_TTL_SECONDS`.

### 7.3 Other multipart configs (out of this slice's scope)

`STORAGE_MULTIPART_THRESHOLD_BYTES` and `STORAGE_MULTIPART_PART_SIZE_BYTES`
are also required by the issue but belong to the storage/client slices,
not the schema/lifecycle slice. They land in the same config object on
the same arms (`S3StorageConfig` / `LocalStorageConfig`) following the
same pattern. Noted for the cross-slice ToC.

---

## 8. Backward compatibility

### 8.1 Single-protocol rows are untouched

- Existing rows pick up `protocol='single'` from the column default
  during `ALTER TABLE ADD COLUMN`.
- `upload_id`, `part_size`, `expected_parts` default to NULL on existing
  rows — consistent with the discriminator semantics.
- The existing sweep query (Phase 1) `WHERE status='pending' AND
  created_at < ?` continues to match single-protocol rows exactly as
  before. The new multipart-only phases (1.5, 1.6) filter on
  `protocol='multipart'` and `status='aborting'`, so they cannot touch
  single rows.
- `finalize` (existing single-PUT path) makes no use of the new columns.
  The dispatch in `upload-tickets.ts:finalize` will gain a top-level
  branch on `ticketRow.protocol` that routes multipart to a new
  `completeMultipart` helper, single to the existing logic. No change for
  rows where `protocol='single'`.

### 8.2 Status-enum widening is non-breaking at compile time

The `UploadTicketStatus` type is consumed in exactly these places (grep
confirmed):

| File | Line | What it does | Required change |
|---|---|---|---|
| `apps/server/src/tickets/upload-tickets.ts` | 45 | Type definition `UploadTicketStatus` | Add `'aborting'`. |
| `apps/server/src/tickets/upload-tickets.ts` | 56 | `UploadTicket.status` property typed by the union | Picks up the new value automatically. |
| `apps/server/src/tickets/upload-tickets.ts` | 268 | `if (ticketRow.status === 'completed')` — early-return idempotency | No change. Falls through for `aborting`. New code below adds the `aborting` rejection branch (per §4.3). |
| `apps/server/src/tickets/upload-tickets.ts` | 283 | `if (ticketRow.status === 'expired')` — early-return failure | No change. |
| `apps/server/src/tickets/sweep.ts` | 81 | `TERMINAL_STATUSES = ['expired', 'failed', 'completed']` | **Do NOT add `'aborting'`**. It is transient. |
| `apps/server/src/tickets/sweep.ts` | 118 | `eq(uploadTickets.status, 'pending')` for the bulk pending expiry | No change. Excludes `aborting` already. |
| `apps/server/src/tickets/sweep.ts` | 175 | `inArray(uploadTickets.status, [...TERMINAL_STATUSES])` for retention | No change. |
| `apps/server/src/db/schema.ts` | 218 | The Drizzle enum on the column | Widen to `['pending', 'completed', 'failed', 'expired', 'aborting']`. |
| `apps/server/src/routes/public-upload-tickets.ts` | 38-47 | `switch` over `finalize` outcome `kind` — NOT over the status enum directly | No change. The outcome union widens to include `{ kind: 'aborting' }` if we expose that to the public surface; otherwise the route maps it to a 409 generic response. |

No exhaustive `switch (status)` exists in the codebase today, so
widening the enum is non-breaking at compile time. The new finalize
outcome kinds (`already_aborting`, `aborting`, `already_completed` from
the abort code path) DO need new `case` arms in the route handler — but
those are introduced alongside the new abort route, not retrofitted onto
the existing finalize handler.

### 8.3 Cascade behaviour unchanged for single

Receive-link / send-link `remove` paths still issue
`db.delete(receiveLinks)` / `db.delete(sendLinks)`. The CASCADE on
`upload_tickets.{receive_link_id, send_link_id}` still hard-deletes
pending single-protocol tickets exactly as today. The pre-delete hook
(§5) only enumerates `protocol='multipart' AND status='pending'`, so it's
a no-op for the existing single-only world. Existing tests for the
cascade behaviour continue to pass without modification.

### 8.4 `download_tickets` unaffected

This slice does not touch `download_tickets`. The download-side status
enum stays at `['pending', 'completed', 'failed', 'expired']`.

---

## 9. Open questions / deferred

- **Per-part etag verification on local backend.** S3 returns an etag
  per part that's load-bearing for `completeMultipart`. Local needs a
  parallel — sha256 of the part bytes — recorded in
  `upload_ticket_parts.etag`. This is a storage-slice concern, surfaced
  here only because the schema column needs to be present.
- **Abort attempts counter.** Deferred. If sweep-retries-forever
  becomes operationally annoying we add `aborting_attempts integer
  default 0` in a follow-up migration and transition to a new
  `abort_failed` terminal after N attempts.
- **Status SQL CHECK.** Deferred. Out of scope unless we're already doing
  a table rebuild for another reason; see §1.3.
