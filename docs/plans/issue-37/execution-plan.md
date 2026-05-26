# Execution Plan — Issue #37: Multipart Upload

This is the authoritative brief for the execution team. It reconciles the four
domain plans (`agents/storage-protocol.md`, `agents/db-schema-lifecycle.md`,
`agents/frontend-multipart.md`, `agents/lifecycle-security.md`) and locks every
ambiguity that surfaced across them. Where the four plans disagree, this doc
overrides them and the rule below applies.

---

## TL;DR (for the issue comment)

- Add a multipart upload protocol on top of the existing `StorageProvider`
  seam: `initMultipart` / `presignUploadPart` / `completeMultipart` /
  `abortMultipart`, implemented for both S3 and local backends, with the
  local backend gaining one new HMAC-signed route (`PUT-PART`) and
  `.multipart/<uploadId>/` session storage.
- Frontend dispatches single-PUT vs multipart on file size against a
  server-issued threshold (`/api/config/upload`), uploads parts in parallel
  with per-part retry, aggregates progress, and surfaces a Cancel button.
- Schema migration `0006_*` extends `upload_tickets` with `protocol`,
  `upload_id`, `part_size`, `expected_parts`, `abort_attempts`; adds
  transient statuses `completing` and `aborting`; introduces
  `upload_ticket_parts` and `pending_aborts` tables.
- Cascade-abort uses **both** a fire-and-forget inline `storage.abortMultipart`
  on link delete **and** a durable `pending_aborts` queue drained by sweep —
  no orphaned S3 sessions, no orphaned local parts dirs, even on crash.
- README gains a new `## Large file uploads` section and the existing CORS
  recipes gain `Access-Control-Expose-Headers: ETag`.
- Hand-verification covers the 2 GiB local-CF-tunnel happy path, a 50 GiB
  MinIO happy path, single-PUT smoke, per-part retry, cancel, link-delete
  mid-upload, and sweep-after-TTL.

---

## Reconciliations

### R1. Cascade-abort = inline best-effort + durable `pending_aborts` queue

DB-schema agent (§5) recommended B-inline alone. Lifecycle-security agent
(§4) recommended `pending_aborts` queue + inline best-effort. We adopt the
lifecycle-security agent's combined approach. The inline call gives the
"abort within 1 s" UX win the acceptance criterion asks for; the queue is
the durable safety net for the failure cases (S3 hiccup, process crash
between enqueue and inline call). The cost is one small table + one sweep
phase — well within the scope of "robust unless cost is genuinely
disproportionate." **`receive-links.remove` / `send-links.remove` enqueue
`pending_aborts` rows BEFORE the CASCADE delete and then fire the inline
abort; on inline success the row deletes itself, on failure sweep Phase 1.7
drains it.** The `pending_aborts.backend` column from lifecycle-security
§4 is dropped — the running process always knows its own backend, so the
sweep just calls `storage.abortMultipart` on whatever provider is wired.

### R2. Status enum widened with both `completing` AND `aborting`

Storage agent §7.5 and lifecycle-security §1.5 both need a `completing`
transient as the load-bearing CAS-style race guard between
`completeMultipart` and `abortMultipart`/`sweep`. DB-schema agent's enum
only adds `aborting`. **Final status enum:
`['pending', 'completing', 'completed', 'failed', 'expired', 'aborting']`.**
Both transient states are non-terminal and excluded from
`TERMINAL_STATUSES` in `sweep.ts`. Migration `0006_*` stays an ADD COLUMN
migration (no SQL CHECK on status today, so the widening is TS-only and
non-breaking — DB-schema §1.3 already verified this).

### R3. Part-PUT Content-Type is NOT signed and NOT sent

Storage agent §2.2 deliberately omits ContentType from S3's
`UploadPartCommand` presign; storage agent §3.5's PUT-PART canonical
includes the field positionally but always passes `undefined` so the
canonical line is empty. The local part-PUT route MUST NOT consume a `ct`
query parameter — the route is wired with `contentType: undefined` in the
verifier call. **The frontend XHR MUST NOT call
`xhr.setRequestHeader('Content-Type', ...)` for part PUTs.** Sending the
header would either (a) for S3, break `SignatureDoesNotMatch` because the
SigV4 presign for `UploadPart` doesn't cover it but some intermediaries
might forward it inconsistently, or (b) for local, be redundant. Frontend
agent §7 had this right; lock it.

### R4. ETag exposure: S3 CORS update REQUIRED + local backend exposes too

Frontend agent §7 raised the S3 CORS gap correctly. **README CORS recipes
(R2, MinIO, AWS S3 — lines 181–292) must each add `ExposeHeaders: ['ETag']`
(or the platform-equivalent key).** Without this, `xhr.getResponseHeader('ETag')`
returns `null` cross-origin and the entire `complete` step silently fails.
For the local backend, the part-receive route returns ETag both as an
`ETag:` response header AND as a JSON body field `{ etag, size }`. The
frontend reads the header first and falls back to the body — one code path
serves both backends.

### R5. Field naming canonical: `expectedParts` (TS) / `expected_parts` (SQL)

All four plans converged on this; the issue body's `partCount` is renamed.
**Every new TS surface uses `expectedParts` exclusively.** No `partCount`
in any new code (server types, client types, JSON wire shapes).

### R6. Pagination: server caps at 100/page, client window = 2×CONCURRENCY, fetch page = 100

Storage agent §4.4 picked 100 inline + 100 per page. Frontend agent §6
picked `window = 2 * CONCURRENCY`, `page = max(window, 64)`. The
server-side cap binds. **Server-side: init returns first 100 inline; the
`GET …/parts?from=&to=` endpoint enforces `to - from + 1 <= 100` (400
`invalid_range` on violation).** **Client-side: sliding window of 8
URLs (2 × 4 = default CONCURRENCY), refilled by fetching 100 at a time.**
Frontend agent §6's `URL_FETCH_PAGE` constant becomes `100`, not
`max(window, 64)`.

### R7. Per-part Content-Length: server-derived, signed into URL

Storage agent §3.4 nails this. Frontend sends nothing — the runtime
auto-populates `Content-Length` from the `Blob.slice()`. The local
part-PUT route reads the signed `cl` query param, verifies it against the
header (existing single-PUT pattern in `routes/storage.ts:52-58`), and
streams with the same overrun guard at `routes/storage.ts:99-102`. For
S3, `Content-Length` is not signed into the `UploadPart` presign and is
handled by S3 itself.

### R8. `abort_attempts` column added to `upload_tickets`

Lifecycle-security §5 deferred but recommended. We **add** it in 0006:
`abort_attempts integer not null default 0`. Cleaner than the time-
arithmetic alternative, operator-visible (`SELECT … WHERE abort_attempts >= 20`),
and the column is cheap. Sweep Phase 1.6 increments on each failed
storage-abort attempt; after `MAX_ABORT_ATTEMPTS = 20` the row is
force-transitioned to `expired` with a warn log.

### R9. `STORAGE_MAX_OBJECT_SIZE_BYTES` is in scope

Lifecycle-security §9 added it; storage and DB-schema agents didn't. It
binds both single-PUT and multipart init at the input-validation layer.
**`createForReceiveLink`, `createForSendLink`, `initMultipart`,
`initMultipartForSendLink` all reject `sizeHint > STORAGE_MAX_OBJECT_SIZE_BYTES`
with `invalid_input: size_too_large`.** Defaults per backend: local 50 GiB,
S3 5 TiB.

### R10. Part-receive route MUST consult the DB before writing

Lifecycle-security §7 mandates a `SELECT id, status, expected_parts FROM upload_tickets WHERE upload_id = ?`
gate in the local part-PUT route. Storage agent §4.3 only verifies HMAC +
`meta.json`. The DB check is the disk-fill guard for the multi-hour TTL —
HMAC alone is sufficient for the 5-minute single-PUT presign but not for
the 2-hour multipart TTL. **The execution team threads a small
`uploadTicketsModule.findByUploadId(uploadId)` helper into
`createLocalStorageRoute` (new third constructor argument). The
"storage routes don't touch DB" invariant is explicitly broken here, by
design.**

---

## Scope

### Files modified

- `apps/server/src/storage/index.ts` — extend `StorageProvider` interface
  with `initMultipart` / `presignUploadPart` / `completeMultipart` /
  `abortMultipart`; add new type exports (`InitMultipartOptions`,
  `InitMultipartResult`, `PresignUploadPartOptions`, `CompletedPart`,
  `CompleteMultipartResult`).
- `apps/server/src/storage/s3.ts` — import the four new SDK commands; add
  an in-memory `Map<uploadId, { partSize, sizeHint }>` session cache; add
  the four new methods. `completeMultipart` defensively rejects 200-with-
  empty-ETag responses.
- `apps/server/src/storage/local.ts` — implement the four new methods over
  `.multipart/<uploadId>/` sessions; export `UPLOAD_ID_PATTERN`
  (`/^[a-f0-9]{32}$/`) for the route to reuse.
- `apps/server/src/storage/signing.ts` — widen `CanonicalMethod` to
  include `'PUT-PART'`; add optional `uploadId` and `partNumber` fields to
  `CanonicalParams`; extend `canonical()` with two trailing positional
  lines. Backward-incompatible signature change for in-flight pre-deploy
  single-PUT URLs; acceptable given short presign TTL (default 5 min).
- `apps/server/src/routes/storage.ts` — new
  `PUT /multipart/part/:uploadId/:partNumber` handler reusing the
  single-PUT atomic-write loop, signature check, header parity, and
  overrun guard. Reads `meta.json` to recover bound `key` before
  HMAC verification. Calls `uploadTicketsModule.findByUploadId` to gate
  the write on a `pending` ticket row. Constructor signature grows a
  third parameter: `createLocalStorageRoute(config, uploadTicketsModule)`.
- `apps/server/src/db/schema.ts` — extend `uploadTickets` with `protocol`,
  `uploadId`, `partSize`, `expectedParts`, `abortAttempts`; widen status
  enum; add `uploadTicketParts` table; add `pendingAborts` table.
- `apps/server/src/tickets/upload-tickets.ts` — keep `createForReceiveLink`,
  `createForSendLink`, `finalize` byte-for-byte; add five new methods:
  `initMultipart`, `initMultipartForSendLink`, `getMultipartPartUrls`,
  `completeMultipart`, `abortMultipart`. Add a `findByUploadId(uploadId)`
  helper (returns `{ id, status, expectedParts, partSize, s3Key } | null`).
  Reject `sizeHint > STORAGE_MAX_OBJECT_SIZE_BYTES` in the single-PUT
  paths too.
- `apps/server/src/tickets/sweep.ts` — extend `SweepCounters`; tighten
  Phase 1 with `AND protocol='single'`; add Phase 1.5 (multipart pending
  TTL expiry), Phase 1.6 (drain `aborting`), Phase 1.7 (drain
  `pending_aborts`); thread `storage`, `uploadTicketsModule`,
  `multipartTtlSeconds` into `TicketSweeperDeps`.
- `apps/server/src/links/receive-links.ts` — `remove(id)` enqueues
  `pending_aborts` rows for in-flight multipart tickets, then fires
  inline best-effort `storage.abortMultipart`, then CASCADE-deletes the
  link (so the existing FK CASCADE still wipes the rows).
- `apps/server/src/links/send-links.ts` — symmetric `remove(id)` patch.
- `apps/server/src/config.ts` — add `STORAGE_MULTIPART_THRESHOLD_BYTES`,
  `STORAGE_MULTIPART_PART_SIZE_BYTES`, `STORAGE_MULTIPART_TTL_SECONDS`,
  `STORAGE_MAX_OBJECT_SIZE_BYTES` env parsing; add `MultipartConfig`
  shared sub-object on both storage discriminant arms; add boot
  validation rules (min part size 5 MiB, max ≤ threshold + part-size
  product fits 10_000 parts).
- `apps/server/src/routes/public-receive-links.ts` — add
  `POST /:code/upload/multipart/init`.
- `apps/server/src/routes/public-upload-tickets.ts` — add
  `POST /:ticketId/upload/multipart/complete`,
  `POST /:ticketId/upload/multipart/abort`,
  `GET /:ticketId/upload/multipart/parts?from=&to=`.
- `apps/server/src/routes/send-links.ts` — add admin-side variants
  (`POST /:linkId/files/multipart/init`,
  `POST /:linkId/files/multipart/:ticketId/complete`,
  `POST /:linkId/files/multipart/:ticketId/abort`,
  `GET  /:linkId/files/multipart/:ticketId/parts`).
- `apps/server/src/app.ts` — mount new
  `/api/config/upload` route; thread `uploadTicketsModule` into
  `createLocalStorageRoute(config.storage, uploadTicketsModule)`.
- `apps/web/src/lib/upload.ts` — keep `uploadFileWithProgress` byte-for-
  byte; add types (`UploadProgress`, `UploadResult`, `MultipartDeps`,
  `SinglePutDeps`, `UploadFileInput`, `PartUrl`, `PartEtag`); add
  `uploadFileMultipart` and `uploadFile` dispatcher.
- `apps/web/src/lib/api.ts` — add typed Outcome unions for
  `createMultipartUploadTicket`, `fetchMultipartPartUrls`,
  `completeMultipartUploadTicket`, `abortMultipartUploadTicket`, and
  admin send-link symmetric versions.
- `apps/web/src/pages/PublicReceivePage.tsx` — pre-fetch upload config;
  replace single `uploadFileWithProgress` + `finalizeUploadTicket` call
  with `uploadFile` dispatcher; add Cancel button + `AbortController`;
  extend phase union with `cancelling` / `cancelled`.
- `apps/web/src/pages/NewSendLinkPage.tsx` — per-file loop now calls
  `uploadFile` instead of single-PUT helper; admin-side `MultipartDeps`.
- `apps/web/src/pages/SendLinkDetailPage.tsx` — same shape if/when the
  add-file UX is surfaced; otherwise touchless.
- `README.md` — new `## Large file uploads` section between
  `## Cloudflare Tunnel` and `## Configuration`; CORS recipes updated to
  include `ExposeHeaders: ['ETag']`; Configuration section gains the four
  new env vars and the frontend `VITE_MULTIPART_CONCURRENCY`.

### Files added

- `apps/server/drizzle/0006_<drizzle-kit-slug>.sql` — auto-generated by
  `npm run db:generate`. Contains the four `ALTER TABLE upload_tickets ADD COLUMN`
  statements (`protocol`, `upload_id`, `part_size`, `expected_parts`,
  `abort_attempts`), the `CREATE TABLE upload_ticket_parts` statement
  with composite unique index, the `CREATE TABLE pending_aborts`
  statement with the attempts/enqueued_at index. **Do not hand-author the
  filename** — let drizzle-kit pick the slug; the matching snapshot and
  journal entries land in `drizzle/meta/` simultaneously.
- `apps/server/src/routes/config.ts` — new tiny route module exposing
  `GET /api/config/upload`. No auth. Returns
  `{ multipartThresholdBytes, multipartPartSizeBytes, multipartTtlSeconds, maxObjectSizeBytes }`.
- `apps/web/src/lib/upload-config.ts` — module singleton consuming
  `/api/config/upload`. Lazy-memoized `Promise<UploadConfig>`; one shared
  promise dedupes parallel callers.
- `docs/plans/issue-37/verification.md` (optional but recommended) —
  curl-based smoke script + browser checklist for the hand-verification
  phase. If skipped, place the equivalent shell snippets inside the PR
  body's Test Plan section.

### Files NOT touched (explicit)

- `apps/server/src/storage/s3.ts` `presignPut` / `presignGet` /
  `presignDelete` / `headObject` / `deleteObject` — unchanged.
- `apps/server/src/storage/local.ts` `presignPut` / `presignGet` /
  `presignDelete` / `headObject` / `deleteObject` / `resolveSafe` /
  `verifyLocalStorage` — unchanged.
- `apps/server/src/tickets/upload-tickets.ts`
  `createForReceiveLink` / `createForSendLink` / `finalize` /
  `mintTicket` — unchanged except for the new
  `STORAGE_MAX_OBJECT_SIZE_BYTES` upper-bound check shared with
  multipart init.
- `apps/server/src/tickets/download-tickets.ts` — unchanged.
- `apps/server/src/db/schema.ts` `downloadTickets` table — unchanged.
- `apps/server/src/tickets/sweep.ts` Phase 2 (download pending expiry),
  Phase 3 (terminal upload delete), Phase 4 (terminal download delete) —
  unchanged. Counters extend but the existing fields stay.
- `apps/web/src/lib/upload.ts` `uploadFileWithProgress` — unchanged.
- Single-PUT routes / flows generally — no regression surface.

---

## Step-by-step execution

### Phase 0: Schema migration (drizzle 0006)

Owned by: DB-schema. Blocks: Phases 5, 6, 7, 8, 11, 12.

1. Update `apps/server/src/db/schema.ts`:
   - Widen `uploadTickets.status` enum to
     `['pending', 'completing', 'completed', 'failed', 'expired', 'aborting']`.
   - Add columns: `protocol` (text, NOT NULL, default `'single'`,
     `enum: ['single','multipart']`), `uploadId` (text, NULL),
     `partSize` (integer, NULL), `expectedParts` (integer, NULL),
     `abortAttempts` (integer, NOT NULL, default 0).
   - Add `uploadTicketParts` table with columns
     `id` (text PK), `uploadTicketId` (text NOT NULL, FK to
     `upload_tickets.id` ON DELETE CASCADE), `partNumber` (integer NOT NULL,
     CHECK `>=1 AND <=10000`), `etag` (text NULL),
     `size` (integer NULL), `completedAt` (integer NULL).
     Composite unique index on `(uploadTicketId, partNumber)`.
   - Add `pendingAborts` table with columns
     `id` (integer PK autoincrement),
     `s3Key` (text NOT NULL), `uploadId` (text NOT NULL),
     `reason` (text NOT NULL, CHECK `IN ('link_delete','sweep_drain','complete_failed')`),
     `enqueuedAt` (integer NOT NULL), `attempts` (integer NOT NULL default 0),
     `lastAttemptAt` (integer NULL), `lastError` (text NULL).
     Unique `(s3Key, uploadId)` for idempotent enqueue. Index on
     `(attempts, enqueuedAt)` for the sweep's batched drain.
2. Run `npm run db:generate` in `apps/server`. Commit the resulting
   `drizzle/0006_*.sql`, updated `drizzle/meta/_journal.json`, and the
   new `drizzle/meta/0006_snapshot.json`.
3. Verify the generated SQL against the spec in DB-schema agent §3 (ADD
   COLUMN statements, the `upload_ticket_parts` shape, the
   `pending_aborts` shape with the dropped `backend` column).

### Phase 1: Storage provider interface + S3 + local implementations

Owned by: Storage. Depends on: Phase 0 (only for the
`STORAGE_MAX_OBJECT_SIZE_BYTES` validation in `initMultipart`; can start
in parallel and stub the bound).

1. Extend `StorageProvider` interface per storage agent §1. Add the four
   methods with the exact signatures spelled out there.
2. Implement `s3.ts` per storage agent §2. Import `CreateMultipartUploadCommand`,
   `UploadPartCommand`, `CompleteMultipartUploadCommand`,
   `AbortMultipartUploadCommand`. The session map is closure-scoped.
   `completeMultipart` MUST defensively reject responses with an empty
   `res.ETag` field (200-with-`<Error>`-body case, storage agent §2.3).
3. Implement `local.ts` per storage agent §3. On-disk layout
   `${objectsDir}/.multipart/<uploadId>/{meta.json,<n>.part,<n>.part.meta.json}`.
   `uploadId = randomUUID().replace(/-/g, '')`. `initMultipart` writes
   `meta.json` atomically via temp-then-rename. `completeMultipart`
   streams parts sequentially through a single `FileHandle.write` loop
   (the same handle pattern used by the existing PUT route to avoid the
   WriteStream/handle deadlock documented at `routes/storage.ts:81-91`).
   `abortMultipart` uses `fs.rm({ recursive: true, force: true })`.
   Export `UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/`.

### Phase 2: HMAC signing extension

Owned by: Storage. Blocks: Phase 3.

Edit `apps/server/src/storage/signing.ts`:

1. `export type CanonicalMethod = 'PUT' | 'GET' | 'DELETE' | 'PUT-PART';`
2. Add `uploadId?: string` and `partNumber?: number` to `CanonicalParams`.
3. Extend `canonical()` with two trailing positional lines:
   `p.uploadId ?? ''` and `p.partNumber !== undefined ? String(p.partNumber) : ''`.
4. Acknowledge backward-incompatibility for in-flight single-PUT URLs at
   deploy time (acceptable: ≤5 minute presign TTL means seconds-to-
   minutes of in-flight URLs at deploy time, all single-PUT, all
   short-lived).

### Phase 3: Local-backend part-receive route

Owned by: Storage + Lifecycle-security (R10 coupling). Depends on:
Phase 2, Phase 0 (schema for `findByUploadId`).

Edit `apps/server/src/routes/storage.ts`:

1. Change `createLocalStorageRoute(config)` to
   `createLocalStorageRoute(config, uploadTicketsModule)`.
2. Add `route.put('/multipart/part/:uploadId/:partNumber', async (c) => …)`:
   - Validate `uploadId` matches `UPLOAD_ID_PATTERN`; 400 `invalid_upload_id`.
   - Parse `partNumber` integer in `[1, 10000]`; 400 `invalid_part_number`.
   - Open `${objectsDir}/.multipart/<uploadId>/meta.json`; on ENOENT,
     403 `invalid_signature` (same shape as bad sig; do not leak that the
     session is gone).
   - Recover `meta.key`, run `checkSignature(c, 'PUT-PART', meta.key, secret)`
     with `contentType: undefined` and the signed `cl` recovered from the
     URL. On failure, 403 `invalid_signature`.
   - `uploadTicketsModule.findByUploadId(uploadId)` → must return a row
     with `status === 'pending'`; otherwise 410 `session_closed`.
     `partNumber > row.expectedParts` → 400 `invalid_part_number`.
   - Stream the body to
     `<.multipart>/<uploadId>/<partNumber>.part.tmp-<rand>`; reuse the
     existing single-PUT atomic-write/fsync/overrun-guard pattern (lines
     73-129 of `routes/storage.ts`).
   - On success: rename to `<partNumber>.part`, write the per-part
     sidecar `<partNumber>.part.meta.json` with `{ etag, size }`, return
     `200 { etag, size }` with header `ETag: "<sha256-hex>"`.
3. The `app.ts` mount site grows the new argument; thread
   `uploadTicketsModule` through.

### Phase 4: Config additions + `/api/config/upload` endpoint

Owned by: Storage. Independent of Phases 0–3 except for the eventual
threading; can start in parallel.

1. Edit `apps/server/src/config.ts`:
   - Add `MultipartConfig` interface (`thresholdBytes`, `partSizeBytes`,
     `ttlSeconds`, `maxObjectSizeBytes`).
   - Hang it off both `S3StorageConfig` and `LocalStorageConfig` as a
     `multipart: MultipartConfig` field (mirror lifecycle-security §9.1
     option (a)).
   - Add `parseMultipartConfig(env, backend)` reading
     `STORAGE_MULTIPART_THRESHOLD_BYTES` (default `100*1024*1024`),
     `STORAGE_MULTIPART_PART_SIZE_BYTES` (default `16*1024*1024`,
     min 5 MiB, max 5 GiB),
     `STORAGE_MULTIPART_TTL_SECONDS` (default `7200`),
     `STORAGE_MAX_OBJECT_SIZE_BYTES` (default per backend: local
     `50 * 2^30`, S3 `5 * 2^40`).
   - Boot validation: `maxObjectSizeBytes > thresholdBytes`,
     `partSizeBytes * 10_000 >= maxObjectSizeBytes`.
2. Create `apps/server/src/routes/config.ts`:
   ```ts
   export function createConfigRoute(storage: StorageConfig): Hono {
     const route = new Hono();
     route.get('/upload', (c) => c.json({
       multipartThresholdBytes: storage.multipart.thresholdBytes,
       multipartPartSizeBytes:  storage.multipart.partSizeBytes,
       multipartTtlSeconds:     storage.multipart.ttlSeconds,
       maxObjectSizeBytes:      storage.multipart.maxObjectSizeBytes,
     }));
     return route;
   }
   ```
3. Mount in `app.ts`: `api.route('/config', createConfigRoute(config.storage));`.

### Phase 5: Upload-tickets module multipart methods

Owned by: Lifecycle-security. Depends on: Phase 0, Phase 1, Phase 4.
Blocks: Phase 6.

Edit `apps/server/src/tickets/upload-tickets.ts`:

1. Add type exports per lifecycle-security agent §1
   (`InitMultipartInput`, `InitMultipartResult`,
   `InitMultipartOutcome`, `InitMultipartForSendLinkInput`,
   `InitMultipartForSendLinkOutcome`, `PartUrlsResult`,
   `PartUrlsOutcome`, `CompletedPart`, `CompleteMultipartOutcome`,
   `AbortMultipartOutcome`).
2. Add five methods on `UploadTicketsModule`:
   - `initMultipart(input)`: validates (incl. `size > 0` and
     `size <= maxObjectSizeBytes`), runs the full receive-link policy
     gate (same `recordUploadCount` → `resolvePasswordCheck` →
     `evaluateReceiveLink` triple as `createForReceiveLink`), computes
     `partSize` and `expectedParts`, mints `ticketId`, calls
     `storage.initMultipart`, persists the ticket row with
     `protocol='multipart'`, `upload_id`, `part_size`, `expected_parts`,
     `status='pending'`, builds the first batch of 100 part URLs,
     returns the outcome. Log `[upload-tickets] multipart-init { … }`.
   - `initMultipartForSendLink(input)`: mirror, only the `disabled`
     branch fires.
   - `getMultipartPartUrls(ticketId, from, to, password?)`: ticket
     lookup, protocol + status + range + per-call cap check
     (`to - from + 1 <= 100`), receive-side policy re-run (skip for
     send-side per lifecycle-security §3), `presignUploadPart` loop.
   - `completeMultipart(ticketId, { parts, providedPassword? })`:
     idempotency on `completed`, branch on `aborting`/`expired`/`failed`/
     `completing` returning `wrong_state`, policy re-run, atomic
     `UPDATE … SET status='completing' WHERE id=? AND status='pending' AND protocol='multipart'`
     guard (release back to `pending` on parts-validation failure),
     `storage.completeMultipart`, `storage.headObject` size-match,
     `files.create`, `UPDATE … SET status='completed' WHERE status='completing'`,
     notification record (try/catch). **On `storage.completeMultipart`
     throw**: insert a `pending_aborts` row with `reason='complete_failed'`
     (ON CONFLICT DO NOTHING), then `UPDATE … SET status='failed' WHERE status='completing'`.
   - `abortMultipart(ticketId, { providedPassword? })`: branch by
     current status (per lifecycle-security §1 `abortMultipart` block);
     on `pending`, atomic CAS to `aborting` and call
     `storage.abortMultipart`; on success transition to `expired`; on
     throw, leave in `aborting` for sweep Phase 1.6.
3. Add `findByUploadId(uploadId: string): Promise<…>` helper for the
   part-receive route. Returns `{ id, status, expectedParts, partSize, s3Key }`
   or null.

### Phase 6: Public routes (init/get-parts/complete/abort) + admin variants

Owned by: Lifecycle-security. Depends on: Phase 5.

1. `apps/server/src/routes/public-receive-links.ts`: add
   `POST /:code/upload/multipart/init` that proxies to
   `uploadTicketsModule.initMultipart`. Outcome → HTTP code per
   `lifecycle-security` agent's "Cross-references for other agents"
   (404 `link_not_found`, 400 `invalid_input`, 403 `policy_rejected`,
   200 ok).
2. `apps/server/src/routes/public-upload-tickets.ts`: add
   - `POST /:ticketId/upload/multipart/complete`
   - `POST /:ticketId/upload/multipart/abort`
   - `GET  /:ticketId/upload/multipart/parts?from=&to=`
   Map outcomes to status codes:
   `ticket_not_found` → 404, `wrong_state` → 410, `not_multipart` → 400,
   `invalid_input` → 400, `policy_rejected` → 403/451 per existing
   convention, `completed` → 200 `{ status: 'completed', fileId }`,
   `aborted`/`already_*` → 200.
3. `apps/server/src/routes/send-links.ts`: add admin variants under
   `/api/send-links/:linkId/files/multipart/{init,:ticketId/complete,:ticketId/abort,:ticketId/parts}`.
   `requireAdmin`-gated like the existing send-link routes. Same shapes
   as the public ones, modulo the admin-bypass on policy.

### Phase 7: Cascade-abort hook on link delete + pending_aborts

Owned by: Lifecycle-security. Depends on: Phase 0, Phase 1, Phase 5.

1. Edit `apps/server/src/links/receive-links.ts` `remove(id)`:
   - SELECT in-flight multipart tickets:
     `WHERE receive_link_id=? AND protocol='multipart' AND status IN ('pending','aborting','completing') AND upload_id IS NOT NULL`.
   - For each row, `INSERT INTO pending_aborts (s3_key, upload_id, reason, enqueued_at, attempts) VALUES (?, ?, 'link_delete', ?, 0) ON CONFLICT DO NOTHING`.
   - Perform the existing `db.delete(receiveLinks).where(eq(receiveLinks.id, id))`.
     CASCADE wipes the ticket rows.
   - For each snapshot row, fire-and-forget
     `storage.abortMultipart(s3Key, uploadId).then(deleteFromPendingAborts).catch(logWarn)`.
2. Symmetric edit in `apps/server/src/links/send-links.ts` `remove(id)`.

### Phase 8: Sweep extension

Owned by: Lifecycle-security. Depends on: Phase 0, Phase 1, Phase 4.

Edit `apps/server/src/tickets/sweep.ts`:

1. Extend `SweepCounters` with `abortedPendingMultipart`,
   `drainedAborting`, `drainedPendingAborts`.
2. Extend `TicketSweeperDeps` with `storage: StorageProvider`,
   `uploadTicketsModule: UploadTicketsModule` (only used for typing if
   not directly called), and `multipartTtlSeconds: number`.
3. Tighten Phase 1's UPDATE with `AND protocol='single'`.
4. Insert Phase 1.5 (TTL-expire multipart pending — CAS to `aborting`,
   call `storage.abortMultipart`, CAS to `expired`) per lifecycle-security
   §5.
5. Insert Phase 1.6 (drain `aborting`) — per-row, increment
   `abort_attempts`; after `MAX_ABORT_ATTEMPTS = 20`, force to `expired`
   with a warn log.
6. Insert Phase 1.7 (drain `pending_aborts`) — per-row, batch limit 100,
   delete on success / increment attempts on failure; after
   `MAX_PENDING_ABORT_ATTEMPTS = 20` stop retrying (operator cleanup).
7. Extend the "only log when something happened" gate to sum the new
   counters.
8. Wire the new deps in `app.ts`'s sweeper construction.

### Phase 9: Frontend upload-config singleton

Owned by: Frontend. Independent.

Create `apps/web/src/lib/upload-config.ts` per frontend agent §8. One
lazy-memoized `Promise<UploadConfig>`; expose `getUploadConfig()` and a
test-only reset. Add a NaN-guarded fallback so a malformed `/api/config/upload`
response can't take the page down: if the JSON parse fails or fields are
missing, fall back to hard-coded sane defaults (100 MiB threshold, 16 MiB
part size, 7200s TTL, 5 GiB max object size) and log a warning.

### Phase 10: Frontend `upload.ts` dispatcher + `uploadFileMultipart`

Owned by: Frontend. Depends on: Phase 9. Independent of server phases
(can be developed against stub `MultipartDeps`).

Edit `apps/web/src/lib/upload.ts` per frontend agent §1–6:

1. Add the type exports.
2. Add `uploadFile(input: UploadFileInput): Promise<UploadResult>`. The
   dispatcher: `file.size === 0 || file.size <= threshold` → wrap
   `single.presign()` + `uploadFileWithProgress` + `single.finalize()`
   and return `{ kind: 'single', ... }`. Otherwise → `uploadFileMultipart`.
3. Add `uploadFileMultipart` per frontend agent §3 (concurrency-bounded
   worker loop) and §4 (two-map progress aggregation with throttle).
4. Per-part retry per frontend agent §3: 3 retries, exponential backoff
   1s/2s/4s with ±20% jitter; retry network errors / 5xx / 408 / 429;
   permanent on any other 4xx.
5. AbortSignal plumbing per frontend agent §5: internal AbortController,
   5s-ceiling abort call. **Do NOT** call `xhr.setRequestHeader('Content-Type', …)`
   on the part XHRs (R3).
6. ETag extraction: `xhr.getResponseHeader('ETag') ?? parseEtagFromJsonBody(xhr.responseText)`.
   A missing/null ETag is a permanent failure for that part.
7. Sliding-window URL prefetch per frontend agent §6 with
   `URL_WINDOW_SIZE = 2 * MULTIPART_CONCURRENCY` and `URL_FETCH_PAGE = 100`
   (R6).

### Phase 11: Frontend `api.ts` wrappers (typed Outcome unions)

Owned by: Frontend. Depends on: Phase 6.

Edit `apps/web/src/lib/api.ts`:

1. Add the typed Outcome unions per frontend agent §7
   (`CreateMultipartUploadTicketOutcome`, `FetchMultipartPartUrlsOutcome`,
   reuse existing `FinalizeOutcome`).
2. Implement:
   - `createMultipartUploadTicket(code, payload)`
   - `fetchMultipartPartUrls(ticketId, from, to)`
   - `completeMultipartUploadTicket(ticketId, payload)`
   - `abortMultipartUploadTicket(ticketId)` — fire-and-forget with
     `keepalive: true`.
   - Admin send-link symmetric versions.
3. Use `expectedParts` (not `partCount`) in every type and JSON shape
   (R5).
4. The init JSON shape returned from the server contains
   `urls: { kind: 'inline'; urls: PartUrl[] } | { kind: 'paginated' }`
   and `partsRemaining` / `nextPartsUrl` are also surfaced (for parity
   with the server wire shape). The wrappers normalise into the
   `MultipartDeps.init()` return shape `uploadFileMultipart` expects.

### Phase 12: Page integration + Cancel button

Owned by: Frontend. Depends on: Phase 9, Phase 10, Phase 11.

1. `PublicReceivePage.tsx`: per frontend agent §9. Pre-fetch
   `Promise.all([getPublicReceiveLink(code), getUploadConfig()])`.
   Replace the existing `uploadFileWithProgress` + `finalizeUploadTicket`
   call with `uploadFile({ … threshold, single, multipart, signal })`.
   Add Cancel button visible during minting/uploading/finalizing phases.
   Extend phase union with `'cancelling' | 'cancelled'`.
2. `NewSendLinkPage.tsx`: per frontend agent §10. Per-file loop body
   reduces to one `uploadFile(...)` per file with admin-side
   `MultipartDeps`. Serial-by-file is preserved.
3. `SendLinkDetailPage.tsx`: only if the add-file UX surfaces in this
   issue; otherwise leave the existing TODO comment intact.

### Phase 13: README "Large file uploads" subsection + CORS updates

Owned by: Documentation. Depends on: Phase 4 (env var names finalised),
Phase 1 (route shapes).

Edit `README.md`:

1. Insert new section `## Large file uploads` after `## Cloudflare Tunnel`
   (line 293) and before `## Configuration` (line 361). Cover:
   - The threshold: files above
     `STORAGE_MULTIPART_THRESHOLD_BYTES` (default 100 MiB) use multipart;
     below stays on single-PUT.
   - Part size: `STORAGE_MULTIPART_PART_SIZE_BYTES` (default 16 MiB) with
     the auto-bump for very large objects to keep ≤10 000 parts.
   - TTL: `STORAGE_MULTIPART_TTL_SECONDS` (default 2h); sweep aborts
     abandoned sessions.
   - Hard ceiling: `STORAGE_MAX_OBJECT_SIZE_BYTES` (default local 50 GiB,
     S3 5 TiB).
   - Cancel / fail / sweep-abort behaviour: in-flight session is aborted
     within ~1s on user cancel; failed past-retries triggers an abort
     too; abandoned sessions are aborted by the sweep on its next tick.
   - The Cloudflare Tunnel Free 100 MB body cap is lifted because each
     part is below the cap; no operator action required.
   - **S3 operators**: enable bucket lifecycle rule
     `AbortIncompleteMultipartUpload` (7-day default) as belt-and-braces
     against rare orphan sessions.
   - **S3 operators**: bucket CORS MUST include
     `Access-Control-Expose-Headers: ETag`. Without it the browser cannot
     read the per-part ETag and `complete` fails.
2. Update the three CORS recipe blocks in `## Storage backends → CORS recipes (S3 mode only)`:
   - **Cloudflare R2** (lines ~181-223): add `ExposeHeaders: ['ETag']` to
     the example CORS JSON.
   - **MinIO** (lines ~224-258): add the analogous setting.
   - **AWS S3** (lines ~259-292): add `<ExposedHeader>ETag</ExposedHeader>`
     to the example.
3. Update `## Cloudflare Tunnel` (line 293) with a brief note that the
   100 MB Free-plan body cap is lifted automatically once `STORAGE_MULTIPART_THRESHOLD_BYTES`
   is set (the default does it).
4. Extend `## Configuration` (line 361) sections:
   - `### Storage — local mode`: add the four new env vars and
     `VITE_MULTIPART_CONCURRENCY` (frontend build-time; document that
     rebuilding the frontend is required to change it, then point at the
     server-issued `/api/config/upload` knobs).
   - `### Storage — S3 mode`: same four envs.
5. Optionally extend `## Limitations of v1` (line 456) to drop the
   "multipart is a likely v2" bullet now that v2 has shipped.

### Phase 14: Hand-verification script

Owned by: Verification. Depends on: everything.

Manual verification — there is no test framework in this repo. Steps:

1. **Lint + build + migrate.**
   ```bash
   npm --workspace apps/server run lint
   npm --workspace apps/server run build
   npm --workspace apps/server run db:generate   # should be a no-op after Phase 0
   npm --workspace apps/server run db:migrate
   npm --workspace apps/web run lint
   npm --workspace apps/web run build
   ```
2. **Single-PUT smoke (regression guard).** Start dev server, upload a
   1 MiB file via `/r/<code>` — confirm it still uses single-PUT
   (network tab shows one PUT to `/api/storage/o/put/...`).
3. **Local multipart happy path.** Upload a 200 MiB file via `/r/<code>`
   — confirm `POST .../upload/multipart/init`, parallel PUTs to
   `/api/storage/o/multipart/part/<uploadId>/<n>`, then `POST .../complete`.
   Progress bar advances monotonically.
4. **Cancel mid-upload.** Start a 200 MiB upload, click Cancel after
   ~30% — confirm `POST .../abort` fires, the parts dir at
   `${LOCAL_OBJECTS_DIR}/.multipart/<uploadId>/` is gone within 1 s,
   the ticket row is `expired`.
5. **Per-part retry.** Inject a transient 503 on one part (proxy /
   throttle in devtools) — confirm the worker retries and the upload
   completes.
6. **Link delete mid-upload.** Start an upload, then DELETE the parent
   receive link from the admin dashboard — confirm the upload fails with
   a server-side error, the parts dir is gone, and the
   `pending_aborts` table is empty (inline abort succeeded) or holds the
   row briefly before the sweep drains it.
7. **Sweep TTL.** Manually set `STORAGE_MULTIPART_TTL_SECONDS=30` in
   `.env`, start an upload and pause it (devtools network throttle), wait
   ~90s — confirm sweep aborts the session and the row transitions to
   `expired`.
8. **2 GiB via CF Tunnel.** Run the container with `STORAGE_BACKEND=local`
   and the tunnel enabled per the README. Upload a 2 GiB file. Confirm
   end-to-end success (the immediate motivator).
9. **S3 50 GiB.** With MinIO in Docker, upload a 50 GiB file. Confirm
   end-to-end success, server RSS does not balloon (≤ ~200 MiB), no
   orphaned sessions: `aws s3api list-multipart-uploads --bucket <b>`
   is empty after.
10. **`/api/config/upload` shape.** `curl http://localhost:3000/api/config/upload`
    returns the four expected keys with reasonable defaults.

If any of 2–7 fail, file blocker. Steps 8–9 are the headline
acceptance criteria — they MUST pass.

---

## Parallelization map

- Phase 0 (schema) blocks Phases 5, 7, 8, 11, 12.
- Phase 1 (storage provider) blocks Phases 3, 5, 7, 8.
- Phase 2 (signing) blocks Phase 3.
- Phase 3 (local part route) needs Phase 0 + Phase 2 + Phase 5's
  `findByUploadId` helper (extract the helper first as a sub-deliverable
  of Phase 5; the rest of Phase 5 can land after).
- Phase 4 (config + `/api/config/upload`) is independent; lands in
  parallel with anything; only Phase 9 consumes it.
- Phase 5 blocks Phase 6 and (partially via `findByUploadId`) Phase 3.
- Phase 6 blocks Phase 11; Phase 7 and Phase 8 are independent of
  Phase 6.
- Phase 9 (frontend config singleton) is independent.
- Phase 10 (frontend dispatcher) is independent of server phases (can
  develop against stubs). Depends on Phase 9 for `getUploadConfig()`.
- Phase 11 (frontend API wrappers) depends on Phase 6.
- Phase 12 (page integration) depends on Phase 9, 10, 11.
- Phase 13 (README) depends on Phase 4 (env names) and is otherwise
  independent.
- Phase 14 depends on every prior phase.

Practical execution order with maximum parallelism:

```
Phase 0  ─┬─────────────────────────────────────────────────┐
Phase 1  ─┼──┐                                              │
Phase 2  ─┘  │                                              │
             ▼                                              │
Phase 5  ────┼──┐                                           │
             │  │                                           │
Phase 3  ────┘  │  (after Phase 5's findByUploadId helper)  │
                │                                           │
Phase 6  ───────┼──┐                                        │
Phase 7  ───────┘  │                                        │
Phase 8  ───────┐  │                                        │
                │  │                                        │
Phase 4  ────┐  │  │                                        │
             │  │  │                                        │
Phase 9  ────┘  │  │                                        │
                │  │                                        │
Phase 10 ───────┘  │                                        │
                   │                                        │
Phase 11 ──────────┘                                        │
                                                            │
Phase 12 ─────────────────────────────────────────────────  │
                                                            │
Phase 13 ───────────────────────────────────────────────────┘
                                                            │
Phase 14 (verification) — everything must be done           ▼
```

---

## Acceptance-criteria mapping

For each checkbox in the issue:

| # | Criterion | Delivered by |
|---|-----------|--------------|
| 1 | 2 GiB upload via `/r/<code>` works in local + CF Tunnel Free | Phases 1, 3, 4, 5, 6, 10, 11, 12; verified in Phase 14.8 |
| 2 | 50 GiB upload works in S3 (MinIO) | Phases 1, 4, 5, 6, 10, 11, 12; verified in Phase 14.9 |
| 3 | Files ≤ threshold still use single-PUT, no overhead | Phase 10 dispatcher; verified in Phase 14.2 |
| 4 | Per-part retry recovers from transient 5xx | Phase 10; verified in Phase 14.5 |
| 5 | User cancel aborts within 1s; session gone from S3/local | Phase 5 `abortMultipart` + Phase 6 abort route + Phase 10 abort plumbing + Phase 1 idempotent providers; verified in Phase 14.4 |
| 6 | TTL'd sweep aborts abandoned sessions; list-multipart-uploads empty | Phase 8 (Phase 1.5); verified in Phase 14.7 |
| 7 | Deleting parent link mid-upload aborts session promptly | Phase 7 (inline + `pending_aborts`); verified in Phase 14.6 |
| 8 | Progress continuous and monotonic across parts | Phase 10 two-map aggregation; verified in Phase 14.3 |
| 9 | Server memory bounded — streaming concatenation | Phase 1 local `completeMultipart` (sequential handle.write loop); verified in Phase 14.9 |
| 10 | README updated with "Large file uploads" subsection | Phase 13 |
| 11 | No regression to single-PUT, downloads, DELETE, sweep, etc. | Whole plan; verified in Phase 14.2 + observation across other steps |

The "image size delta + added dependencies" bullet from the issue is a
PR-description note. No new deps are introduced (the AWS SDK already has
all multipart commands; no new client lib). Document in the PR body.

---

## Verification commands

```bash
# 1. From repo root — confirm a clean tree and the migration file.
git status

# 2. Schema regen — should be a no-op after Phase 0.
npm --workspace apps/server run db:generate

# 3. Lint + typecheck + build.
npm --workspace apps/server run lint
npm --workspace apps/server run build
npm --workspace apps/web    run lint
npm --workspace apps/web    run build

# 4. Apply migrations against a fresh dev DB.
rm -f apps/server/.data/dev/fileharbor.db
npm --workspace apps/server run db:migrate

# 5. Start the stack.
npm run dev    # or whatever the existing dev-server target is

# 6. Smoke the config endpoint.
curl -s http://localhost:3000/api/config/upload | jq

# 7. Manual browser checklist — work through Phase 14 steps 2-10.
```

If any of steps 2–5 fail, fix and re-run before proceeding. If the
migration regen produces a diff against the committed 0006 file,
investigate — drizzle-kit should be idempotent against the schema.

---

## Notes for the executor

- The `pending_aborts.backend` column from lifecycle-security §4 is
  **dropped** — the running process always knows its own backend.
- The `abort_attempts` column on `upload_tickets` is **added** — DB-schema
  agent deferred it; we add it.
- The `completing` status is **added** — DB-schema agent's enum only had
  `aborting`; we widen to both.
- The part-PUT canonical signs `(method='PUT-PART', key, exp,
  contentType='', contentLength=cl, responseContentDisposition='',
  uploadId, partNumber)` — empty positional fields for the ones not
  applicable. The frontend XHR for parts has NO `Content-Type` header
  set (R3).
- `createLocalStorageRoute(config, uploadTicketsModule)` is the new
  constructor shape — the route is no longer DB-free, by design (R10).
- The frontend `URL_FETCH_PAGE` constant is `100`, not
  `max(window, 64)` (R6).
- No new server-side test framework is introduced; manual verification
  is the bar. The hand-verification script in Phase 14 IS the test
  surface for this PR.
