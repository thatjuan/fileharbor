# Lifecycle & Security — Issue #37 Multipart Upload v2

Scope: the abort / sweep / security surface for the multipart upload protocol.
Sibling agents own the storage-provider methods (`storage.initMultipart`,
`presignUploadPart`, `completeMultipart`, `abortMultipart`), the DB schema
migration, the public route layer, and the frontend dispatcher. This document
specifies how the `UploadTicketsModule`, the link-delete cascade, the sweep,
and the local part-receive route compose into a leak-free lifecycle, and
spells out the security gates around each new entry point.

The design optimises for the most robust option that's consistent with
existing project patterns (`evaluateReceiveLink`, the `WHERE status='pending'`
race-guarded UPDATE, `sanitizeFilename`, the `[ticket-sweep]` log convention,
the discriminated-outcome result shape).

---

## 1. `UploadTicketsModule` — new surface

The existing single-PUT methods (`createForReceiveLink`, `createForSendLink`,
`finalize`) are unchanged. Multipart adds five sibling methods that mirror
the existing outcome-shape convention (`{ kind: 'ok'; value: ... } | { kind: ... } | ...`)
and reuse the existing helpers (`validateUploadInput`, `sanitizeFilename`,
`evaluateReceiveLink`, `resolvePasswordCheck`, `notificationsModule.record`).

```ts
export interface InitMultipartInput {
  linkCode: string;
  filename: string;
  contentType: string;
  size: number;             // total object size in bytes; required for multipart
  providedPassword?: string | null;
}

export interface InitMultipartForSendLinkInput {
  sendLinkId: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface InitMultipartResult {
  ticketId: string;
  uploadId: string;         // S3 upload-id or local ULID
  partSize: number;         // bytes per part the client will use
  expectedParts: number;    // ceil(size / partSize)
  /**
   * First page of presigned PUT-PART URLs, in part-number order starting at 1.
   * Paginated to keep init responses small for very large files; remaining
   * pages are fetched via `getMultipartPartUrls`.
   */
  partUrls: Array<{ partNumber: number; url: string; expiresAt: Date }>;
  /** Highest part number included in `partUrls`. Next page starts at +1. */
  nextPartNumber: number | null;
  /** Per-URL presign expiry — clients refresh expired pages via `getMultipartPartUrls`. */
  ttlSeconds: number;
}

export type InitMultipartOutcome =
  | { kind: 'ok'; value: InitMultipartResult }
  | { kind: 'link_not_found' }
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult }
  | { kind: 'invalid_input'; reason: string };

export type InitMultipartForSendLinkOutcome =
  | { kind: 'ok'; value: InitMultipartResult }
  | { kind: 'link_not_found' }
  | { kind: 'policy_rejected'; policy: { kind: 'disabled' } }
  | { kind: 'invalid_input'; reason: string };

export interface PartUrlsResult {
  partUrls: Array<{ partNumber: number; url: string; expiresAt: Date }>;
  nextPartNumber: number | null;
}

export type PartUrlsOutcome =
  | { kind: 'ok'; value: PartUrlsResult }
  | { kind: 'ticket_not_found' }
  | { kind: 'not_multipart' }        // ticket.protocol === 'single'
  | { kind: 'wrong_state' }          // status not in ('pending')
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult }
  | { kind: 'invalid_input'; reason: string };

export interface CompletedPart { partNumber: number; etag: string }

export type CompleteMultipartOutcome =
  | { kind: 'completed'; fileId: string }
  | { kind: 'failed'; reason: 'object_not_found' | 'parts_invalid' | 'size_mismatch' | 'storage_complete_failed' }
  | { kind: 'ticket_not_found' }
  | { kind: 'wrong_state'; status: UploadTicketStatus } // e.g. 'aborting' or 'expired' from sweep / cascade
  | { kind: 'policy_rejected'; policy: ReceiveLinkPolicyResult };

export type AbortMultipartOutcome =
  | { kind: 'aborted' }
  | { kind: 'already_aborted' }
  | { kind: 'already_completed' }    // race: complete won, abort is a no-op
  | { kind: 'ticket_not_found' };

export interface UploadTicketsModule {
  // existing ...
  initMultipart(input: InitMultipartInput): Promise<InitMultipartOutcome>;
  initMultipartForSendLink(
    input: InitMultipartForSendLinkInput,
  ): Promise<InitMultipartForSendLinkOutcome>;
  getMultipartPartUrls(
    ticketId: string,
    fromPartNumber: number,
    toPartNumber: number,
    providedPassword?: string | null,
  ): Promise<PartUrlsOutcome>;
  completeMultipart(
    ticketId: string,
    input: { parts: CompletedPart[]; providedPassword?: string | null },
  ): Promise<CompleteMultipartOutcome>;
  abortMultipart(
    ticketId: string,
    input?: { providedPassword?: string | null },
  ): Promise<AbortMultipartOutcome>;
}
```

### Method semantics

**`initMultipart`** (receive side):

1. `validateUploadInput` — same as `createForReceiveLink`, but with strict
   size bounds (see §7 — `size > 0` and `size <= STORAGE_MAX_OBJECT_SIZE_BYTES`).
2. `receiveLinksModule.getByCode(input.linkCode)` → `link_not_found` if absent.
3. Re-run the same policy gate as `createForReceiveLink`:
   `recordUploadCount` → `resolvePasswordCheck` → `evaluateReceiveLink`. A
   rejected policy returns `policy_rejected` with the same verdict shape.
4. Compute `partSize = max(STORAGE_MULTIPART_PART_SIZE_BYTES, ceil(size / 10_000))`
   and `expectedParts = ceil(size / partSize)`. Cap at `10_000`
   (S3 hard limit; mirror it on the local backend for parity).
5. Mint the ticket id, build `s3Key = receive/<linkId>/<ticketId>/<filename>`
   (filename run through the existing `sanitizeFilename` helper — same key
   shape as single-PUT so all downstream readers stay untouched).
6. `storage.initMultipart(s3Key, { contentType, size, partSize })` → returns
   `{ uploadId, partSize }`. Persist the ticket row with `protocol='multipart'`,
   `upload_id=uploadId`, `part_size=partSize`, `expected_parts=expectedParts`,
   `status='pending'`, `size_hint=size`.
7. Build the first page of part URLs:
   `firstBatchEnd = min(expectedParts, INIT_PART_URLS_PAGE_SIZE)` —
   recommend `INIT_PART_URLS_PAGE_SIZE = 100`. Loop `partNumber=1..firstBatchEnd`
   calling `storage.presignUploadPart(s3Key, uploadId, partNumber)`. Set
   `nextPartNumber = firstBatchEnd < expectedParts ? firstBatchEnd + 1 : null`.
8. Log `[upload-tickets] multipart-init { ticketId, key, partSize, expectedParts }`.
9. Return `{ kind: 'ok', value: ... }`.

**`initMultipartForSendLink`** (admin side):

Same shape as `createForSendLink`: `getById`, reject `status === 'disabled'`,
no password / quota / expiry. Otherwise identical to `initMultipart`.

**`getMultipartPartUrls`** (lazy pagination):

1. Load the ticket row. `ticket_not_found` if absent. Reject if
   `protocol !== 'multipart'` (`not_multipart`) or `status !== 'pending'`
   (`wrong_state` — the caller has already lost the race to a sweep or abort).
2. Validate the range: `1 <= fromPartNumber <= toPartNumber <= ticket.expected_parts`,
   and cap `(toPartNumber - fromPartNumber + 1) <= MAX_PART_URLS_PAGE` (recommend
   500) — prevents an attacker who guessed an HMAC URL from minting a million
   signatures in a single call. Return `invalid_input` on violation.
3. Re-run policy for `intent='receive'` (same logic as init). Skip for
   `intent='send'` (admin gate already happened at init; admin can't lose
   its own gate mid-upload other than via the `disabled` toggle — and the
   route layer is `requireAdmin`-gated so the caller is the admin themselves).
4. Loop `presignUploadPart` for each part number, return the page +
   `nextPartNumber`.

Re-running policy on every page-fetch is deliberate: it matches `finalize`'s
"re-validate on every state-changing receive-side operation" stance from the
existing module docstring. The cost is one extra `recordUploadCount` query
per page, which is cheap compared to the per-part network upload.

**`completeMultipart`** (idempotent, mirrors existing `finalize`):

1. Load the ticket row. `ticket_not_found` if absent.
2. Idempotency branch: if `status === 'completed'`, return the existing
   `fileId` via `filesModule.listForReceiveLink` / `listForSendLink` lookup
   on `s3Key` (same trick `finalize` uses). Do NOT re-run policy on this
   branch — see existing `finalize` docstring rationale.
3. Branch on terminal/transitional non-completed statuses:
   - `aborting` / `expired` / `failed` → `wrong_state` with the current
     status. The complete-after-abort race is resolved here; see §6.
4. Re-validate policy (same code as init, mirrors `finalize`). On rejection,
   return `policy_rejected` — but DO NOT transition the ticket to `failed`
   or mark it aborted; leave it `pending` so the user can retry once policy
   re-allows (e.g. admin re-enabled a link). The sweep TTL will eventually
   reap it if no further action.
5. Atomic transition guard:
   ```
   UPDATE upload_tickets
     SET status='completing', completed_at=NULL
     WHERE id=? AND status='pending' AND protocol='multipart'
   ```
   Introduces a new transient status `completing` (see schema notes). If
   `changes === 0`, re-load the row and return `wrong_state` — a concurrent
   abort or sweep beat us. Add `completing` to the discriminated
   `UploadTicketStatus`.
6. Validate `parts`: non-empty, length `<= ticket.expected_parts`, all
   `partNumber` integers in `1..ticket.expected_parts`, strictly ascending,
   no duplicates, `etag` non-empty. On failure: `UPDATE ... SET status='pending' WHERE status='completing'`
   to release the guard, return `failed: parts_invalid`.
7. `storage.completeMultipart(s3Key, uploadId, parts)`. This is the call
   that returns 200-with-`<Error>`-body on certain S3 paths; the storage
   layer is responsible for parsing the XML body and throwing — see §6 and
   the storage-agent's plan. On throw: `UPDATE ... SET status='failed', completed_at=now WHERE status='completing'`,
   return `failed: storage_complete_failed`. The S3 multipart session is
   typically already gone after `CompleteMultipartUpload` fails partway, but
   the storage method's contract is "leave no orphan part-state on failure";
   if it can't guarantee that, it queues an entry in the pending-aborts
   table (§4).
8. `storage.headObject(s3Key)`. If `null` → `UPDATE ... SET status='failed' WHERE status='completing'`,
   return `failed: object_not_found`. If `info.size !== ticket.size_hint`
   (the multipart `size` was committed at init, so size mismatch indicates
   a client bug or corruption): same failed-transition + `failed: size_mismatch`.
9. Insert the `file` row (same shape as `finalize`), then
   `UPDATE ... SET status='completed', completed_at=now WHERE id=? AND status='completing'`.
10. Notification recording (receive intent only) — verbatim copy of the
    existing `finalize` notification block, wrapped in try/catch, same
    "notification failure cannot fail the upload" rule.
11. Return `{ kind: 'completed', fileId }`.

**`abortMultipart`** (idempotent):

1. Load the ticket row. `ticket_not_found` if absent.
2. Branch on current status:
   - `completed` → `already_completed` (idempotent no-op; the upload won
     the race — see §6).
   - `expired` / `failed` → `already_aborted` (sweep already finished us;
     S3 / local state is gone).
   - `aborting` → fall through; this is a retry of an in-progress abort.
   - `completing` → reject with `wrong_state` is wrong here because we want
     abort to interrupt. But interrupting a mid-flight `CompleteMultipartUpload`
     is unsafe — S3 doesn't expose "cancel my in-progress complete". Decision:
     when status is `completing`, abort waits (busy-spin is wrong; instead
     return `already_completed` optimistically — the storage `completeMultipart`
     call is short, and the client treats `already_completed` as success.
     Alternative: return a `racing` outcome so the client retries; reject
     because it complicates the UI. Pick the first.). Effectively: complete
     wins ties.
   - `pending` → continue.
3. Atomic transition guard:
   ```
   UPDATE upload_tickets
     SET status='aborting'
     WHERE id=? AND status='pending' AND protocol='multipart'
   ```
   If `changes === 0`, re-load and re-branch (status changed under us).
4. Skip policy — user is cancelling; let them, regardless of password /
   quota / expiry. (A disabled-link abort still does the right thing: it
   frees storage.)
5. `storage.abortMultipart(s3Key, uploadId)` — idempotent on both backends.
   On throw, enqueue into `pending_aborts` (§4) so the sweep retries;
   DO NOT flip status to `expired` yet — leave `aborting` so the sweep
   drains it.
6. On success: `UPDATE ... SET status='expired', completed_at=now WHERE status='aborting'`.
7. Log `[upload-tickets] multipart-abort { ticketId, reason: 'user' }`.
8. Return `{ kind: 'aborted' }`.

Outcome shapes follow the existing `CreateForReceiveLinkOutcome` discriminated-
union convention. Routes translate by mapping `kind` to status codes (the
existing `public-upload-tickets.ts` already has the pattern).

---

## 2. Single-PUT threshold gate

`createForReceiveLink` and `createForSendLink` stay byte-for-byte unchanged.
They are the contract for files ≤ `STORAGE_MULTIPART_THRESHOLD_BYTES` (default
100 MiB) — small uploads keep the single round-trip story and add zero
overhead.

`initMultipart` is the entry point for files > threshold. **The frontend is
the dispatcher**: `apps/web/src/lib/upload.ts` reads the threshold from
`/api/config/upload` (existing endpoint per goal-analysis), and picks
`createForReceiveLink` vs `initMultipart` based on `file.size`.

The server does **NOT** block `initMultipart` for files below threshold.
Rationale:
- A small-file multipart upload works correctly — it's just one or two parts
  with extra round-trips, no integrity risk.
- The threshold is a frontend UX choice (round-trip cost), not a security
  invariant. Adding a server-side floor adds friction during testing and
  scripts (operator-driven uploads at small sizes via the multipart path
  to exercise it) without preventing any actual harm.
- The hard size ceiling — the one that *is* a security invariant — is
  `STORAGE_MAX_OBJECT_SIZE_BYTES` (§7), enforced unconditionally on both
  single and multipart init.

The frontend dispatcher MAY also opt to use single-PUT for files just over
the threshold (e.g. some tolerance band), without server changes — both
paths remain valid.

---

## 3. Policy re-validation

Every multipart entry point that touches link state runs the policy gate.
This mirrors the existing convention (`createForReceiveLink` runs it, then
`finalize` runs it again on completed-ticket finalize).

| Phase                         | Re-run policy? | Notes                                                                                                                              |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `initMultipart`               | **Yes**        | Full gate: `evaluateReceiveLink(link, now, uploadsSoFar, passwordCheck)`. Mirror of `createForReceiveLink`.                        |
| `initMultipartForSendLink`    | **Yes**        | Only the `disabled` branch can fire. Same admin-bypass logic as `createForSendLink`.                                               |
| `getMultipartPartUrls` (recv) | **Yes**        | Catches link-disabled / quota-exhausted between init and a paged URL fetch.                                                        |
| `getMultipartPartUrls` (send) | No             | Admin path, already gated upstream by `requireAdmin`; only `disabled` could change and the sweep / link-delete handles that route. |
| `completeMultipart` (recv)    | **Yes**        | Mirror of `finalize`. Catches an attacker holding a pre-disable ticket.                                                            |
| `completeMultipart` (send)    | **Yes**        | Mirror of `finalize` send branch — only `disabled` fires.                                                                          |
| `abortMultipart`              | **No**         | User is cancelling. Let them, regardless of policy.                                                                                |

### Upload-count semantics (clarification)

`receiveLinksModule.recordUploadCount(linkId)` is implemented as
`SELECT count(*) FROM files WHERE receive_link_id = ?`. It counts **completed
file rows**, not pending tickets. Confirmed in `receive-links.ts:209-216`.

Implication: `initMultipart` does NOT increment any counter. The slot is
"taken" at `completeMultipart` time (when the `file` row is inserted). This
means an in-flight multipart upload does not block a concurrent uploader
from also passing the quota gate — both could init, both could upload, and
the second one to call `completeMultipart` would see `uploadsSoFar` already
at `maxUploads` and get `quota_exhausted`.

This matches the existing single-PUT behaviour (two clients can both
`createForReceiveLink` simultaneously, only one wins at `finalize`) and is
deliberately preserved. No new "reservation" semantics are introduced.

---

## 4. Cascade-abort on link delete

### Problem

`receive_links.id → upload_tickets.receive_link_id` is `ON DELETE CASCADE`
(same for send links). Today: deleting a link wipes the ticket row, leaving
any in-flight S3 `MultipartUpload` session orphaned. S3 charges storage for
incomplete parts indefinitely. Locally, the `${LOCAL_OBJECTS_DIR}/.multipart/<uploadId>/`
directory persists.

The ticket-id row is the only handle that ties an `upload_id` back to
something File Harbor knows about. Once CASCADE deletes it, the upload-id
is unrecoverable from inside the app.

### Recommended approach: persistent `pending_aborts` queue + best-effort inline abort

A new table guarantees robust cleanup even when S3 is briefly unreachable
during link-delete or browser tab close, and even when the inline abort
times out. Sweep drains it.

```sql
CREATE TABLE pending_aborts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backend TEXT NOT NULL CHECK (backend IN ('s3','local')),
  s3_key TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('link_delete','sweep_drain','complete_failed')),
  enqueued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_error TEXT,
  UNIQUE (s3_key, upload_id)  -- idempotent enqueue
);
CREATE INDEX pending_aborts_attempts_idx ON pending_aborts (attempts, enqueued_at);
```

#### Patch to `receive-links.ts` `remove(id)`

Replace the current one-line implementation with:

```ts
async remove(id) {
  // 1. Snapshot in-flight multipart tickets BEFORE CASCADE wipes them.
  //    Status 'pending' covers the common case; 'aborting' covers the
  //    "user clicked cancel, abort hasn't finished, now they delete the
  //    link" race. 'completing' is treated like pending: the storage
  //    completeMultipart call may still succeed, but the link is going
  //    away regardless — best to also enqueue an abort so we don't leak
  //    if completion ultimately fails.
  const inFlight = db
    .select({
      s3Key: uploadTickets.s3Key,
      uploadId: uploadTickets.uploadId,
    })
    .from(uploadTickets)
    .where(
      and(
        eq(uploadTickets.receiveLinkId, id),
        eq(uploadTickets.protocol, 'multipart'),
        inArray(uploadTickets.status, ['pending', 'aborting', 'completing']),
        isNotNull(uploadTickets.uploadId),
      ),
    )
    .all();

  // 2. Enqueue durable abort entries BEFORE the delete. If the process
  //    crashes between enqueue and delete the worst case is an extra
  //    abort entry for a still-existing ticket — abortMultipart on the
  //    storage side is idempotent.
  const now = Math.floor(Date.now() / 1000);
  for (const row of inFlight) {
    if (row.uploadId === null) continue;
    db.insert(pendingAborts)
      .values({
        backend: storageBackend,           // 's3' | 'local' (injected dep)
        s3Key: row.s3Key,
        uploadId: row.uploadId,
        reason: 'link_delete',
        enqueuedAt: now,
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
      })
      .onConflictDoNothing()                // (s3_key, upload_id) unique
      .run();
  }

  // 3. CASCADE delete — wipes upload_tickets rows for this link.
  const result = db.delete(receiveLinks).where(eq(receiveLinks.id, id)).run();

  // 4. Best-effort inline abort. Latency win: most cancellations clear S3
  //    state in <1s without waiting for the sweep tick. Errors are logged
  //    and left for the sweep to retry.
  for (const row of inFlight) {
    if (row.uploadId === null) continue;
    storage
      .abortMultipart(row.s3Key, row.uploadId)
      .then(() => {
        db.delete(pendingAborts)
          .where(and(
            eq(pendingAborts.s3Key, row.s3Key),
            eq(pendingAborts.uploadId, row.uploadId),
          ))
          .run();
        console.log('[upload-tickets] multipart-abort', {
          key: row.s3Key,
          reason: 'link-delete',
          phase: 'inline',
        });
      })
      .catch((err) => {
        console.warn('[upload-tickets] inline link-delete abort failed; sweep will retry', {
          key: row.s3Key,
          err: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return Number(result.changes) > 0;
},
```

The inline abort is fire-and-forget on purpose: link delete is a UI action
and the operator should not wait on S3 latency. If the inline call succeeds,
it deletes its own row in `pending_aborts`. If it fails or the process
dies first, sweep Phase 1.7 (see §5) takes over.

#### Symmetric patch to `send-links.ts` `remove(id)`

Identical structure, with `eq(uploadTickets.sendLinkId, id)` in the snapshot
query. Status filter and `pending_aborts` insert / inline abort are byte-
identical. Same `onConflictDoNothing`.

#### Why not "soft-delete the ticket" (the alternative)

Alternative: `UPDATE upload_tickets SET status='aborting' WHERE receive_link_id=? AND protocol='multipart' AND status IN ('pending','completing')`,
then let CASCADE delete the link, accepting that the `aborting` rows get
wiped too. Sweep can't see them once gone.

This puts us back at the same orphan-leak problem CASCADE caused.
Rejected.

Alternative 2: keep the row alive by nulling the FK (require schema change
to allow `receive_link_id NULL ON DELETE SET NULL`). Adds an "orphan ticket"
row class to every existing query that assumes tickets are link-bound.
Rejected — wider blast radius than `pending_aborts`.

The `pending_aborts` table is small (one row per in-flight multipart at
delete time, removed when abort succeeds), narrowly scoped, and the only
new schema obligation is one migration.

### Why not just "best-effort inline + accept the rare leak"

The prompt called this out as the simpler v2 option ("operator can re-clean
via `aws s3api list-multipart-uploads`"). Reasons to prefer `pending_aborts`:
- "Operator manually runs `aws s3api list-multipart-uploads`" is not a
  policy a self-hoster wants. They opted into File Harbor to avoid that.
- The local backend has no `list-multipart-uploads` equivalent — orphans
  would just be directories under `.multipart/` that the operator would
  have to garbage-collect by hand.
- The robust option is small in code (one table, one sweep phase, ~80 LOC)
  and removes the failure mode entirely.

`pending_aborts` is the recommended choice.

---

## 5. Sweep extension

Three new phases sit between the existing Phase 1 (expire pending tickets)
and Phase 2 (expire pending download tickets). Counters extend the
`SweepCounters` shape. Logging uses the existing `[ticket-sweep]` prefix
and the existing "only log when something happened" rule.

```ts
export interface SweepCounters {
  expiredUploadTickets: number;
  expiredDownloadTickets: number;
  deletedUploadTickets: number;
  deletedDownloadTickets: number;
  // NEW
  abortedPendingMultipart: number;
  drainedAborting: number;
  drainedPendingAborts: number;
}
```

### Phase 1.5 — abort expired pending-multipart tickets

Runs **before** the existing Phase 1 bulk-expire. Phase 1's `UPDATE … WHERE
status='pending'` already covers single-PUT tickets cleanly. Multipart is
different: we must call `storage.abortMultipart` *before* flipping status,
or we'd leak the S3 session.

```ts
const multipartCutoff = nowSeconds - multipartTtlSeconds;
const expirable = db
  .select({
    id: uploadTickets.id,
    s3Key: uploadTickets.s3Key,
    uploadId: uploadTickets.uploadId,
  })
  .from(uploadTickets)
  .where(and(
    eq(uploadTickets.status, 'pending'),
    eq(uploadTickets.protocol, 'multipart'),
    lt(uploadTickets.createdAt, multipartCutoff),
    isNotNull(uploadTickets.uploadId),
  ))
  .all();

for (const row of expirable) {
  // Transition to 'aborting' first (race guard against a late completer).
  const claim = db.update(uploadTickets)
    .set({ status: 'aborting' })
    .where(and(
      eq(uploadTickets.id, row.id),
      eq(uploadTickets.status, 'pending'),
    ))
    .run();
  if (Number(claim.changes) === 0) continue; // a complete() beat us — leave it

  try {
    await storage.abortMultipart(row.s3Key, row.uploadId!);
    db.update(uploadTickets)
      .set({ status: 'expired', completedAt: nowSeconds })
      .where(and(
        eq(uploadTickets.id, row.id),
        eq(uploadTickets.status, 'aborting'),
      ))
      .run();
    counters.abortedPendingMultipart += 1;
  } catch (err) {
    // Leave in 'aborting'; Phase 1.6 will retry, capped by max-attempts.
    log.error('[ticket-sweep] multipart abort failed', { ticketId: row.id, err });
  }
}
```

Single-PUT tickets are still handled by the existing Phase 1 — its
`WHERE status='pending'` filter excludes the multipart rows we already
moved to `aborting`. Actually: it does NOT exclude pending multiparts that
weren't yet past `multipartTtl` but ARE past `presignTtl+grace`. Decision:
tighten Phase 1 to add `AND protocol = 'single'` so single-PUT and
multipart TTLs stay independent (multipart sessions can legitimately live
longer than single-PUT presign TTL — they have to, the upload takes minutes
to hours).

### Phase 1.6 — drain `aborting` tickets

Picks up multipart rows that were transitioned to `aborting` (by user
abort, by Phase 1.5, by `completeMultipart` failure cleanup, etc.) but
where the `storage.abortMultipart` call hasn't succeeded yet.

```ts
const draining = db
  .select({ id, s3Key, uploadId, createdAt })
  .from(uploadTickets)
  .where(and(
    eq(uploadTickets.status, 'aborting'),
    eq(uploadTickets.protocol, 'multipart'),
    isNotNull(uploadTickets.uploadId),
    // Bounded retry — after N sweep ticks (~ N * intervalSeconds), give up
    // and force-mark expired so the row doesn't loop forever. The S3
    // session is now operator-cleanup territory.
    lt(uploadTickets.createdAt, nowSeconds - multipartTtlSeconds + (MAX_DRAIN_TICKS * intervalSeconds)),
  ))
  .all();
```

Per row:
1. Call `storage.abortMultipart`. On success → `UPDATE … SET status='expired'`,
   counter++. On failure → log + leave for the next tick.
2. After N attempts (recommend `MAX_DRAIN_TICKS = 10`) — force the row to
   `expired` regardless and emit a warning log. The `created_at` arithmetic
   above bounds the retry window without needing a separate `attempts`
   column on `upload_tickets`. (If desired, add `abort_attempts integer
   default 0` and increment per drain — cleaner than time-arithmetic. I
   recommend adding it; the column is cheap.)

### Phase 1.7 — drain `pending_aborts`

Handles entries enqueued by `receive-links.remove` / `send-links.remove`
where the inline best-effort abort failed (or the process crashed before
firing it).

```ts
const queue = db
  .select()
  .from(pendingAborts)
  .where(lt(pendingAborts.attempts, MAX_PENDING_ABORT_ATTEMPTS))
  .orderBy(pendingAborts.enqueuedAt)
  .limit(SWEEP_ABORT_BATCH_SIZE)  // recommend 100 per tick to bound work
  .all();

for (const row of queue) {
  try {
    await storage.abortMultipart(row.s3Key, row.uploadId);
    db.delete(pendingAborts)
      .where(eq(pendingAborts.id, row.id))
      .run();
    counters.drainedPendingAborts += 1;
  } catch (err) {
    db.update(pendingAborts)
      .set({
        attempts: sql`${pendingAborts.attempts} + 1`,
        lastAttemptAt: nowSeconds,
        lastError: err instanceof Error ? err.message : String(err),
      })
      .where(eq(pendingAborts.id, row.id))
      .run();
    log.error('[ticket-sweep] pending_abort drain failed', { id: row.id, err });
  }
}
```

After `MAX_PENDING_ABORT_ATTEMPTS` (recommend 20 — ~20 minutes at the
60s default interval), rows are left in the table with no retries. They
surface in a `[ticket-sweep] pending_aborts giving up` warning emitted on
the transition from "would have retried" to "now exceeds cap". An operator
can list and clean these manually:
`SELECT * FROM pending_aborts WHERE attempts >= 20`.

### Counter / log surface

Existing Phase 3 (delete terminal upload tickets) already handles deleting
`expired` rows after `retentionSeconds` — multipart `expired` rows are
indistinguishable from single-PUT `expired` rows here, no change needed.

The "only log when something changed" rule sums all counter deltas; the new
counters fold into that aggregation:
```ts
const changed =
  counters.expiredUploadTickets +
  counters.expiredDownloadTickets +
  counters.deletedUploadTickets +
  counters.deletedDownloadTickets +
  counters.abortedPendingMultipart +
  counters.drainedAborting +
  counters.drainedPendingAborts;
```

### Race-safety carryover

The existing Phase 1's `UPDATE … WHERE status='pending'` race-guard pattern
is reused verbatim in 1.5 (`status='pending'` → `status='aborting'`) and
1.6 (`status='aborting'` → `status='expired'`). Concurrent user
`completeMultipart` and user `abortMultipart` use the same guard
(`WHERE status='pending'`), so at most one of {sweep, complete, abort}
wins the status-transition race per ticket. See §6 for the full table.

---

## 6. Race scenarios

| # | Scenario | Resolution |
|---|----------|------------|
| R1 | User clicks Cancel while last part is uploading. Server processes `abortMultipart` (status: pending → aborting). The in-flight part PUT lands milliseconds later. | Acceptable. S3: the part PUT either lands before `AbortMultipartUpload` (gets stored in the session, then abort discards it) or after (`NoSuchUpload` 404, client already saw cancel succeed and discards the response). Local backend: the part-receive route MUST reject (see R6 and §7) — it re-checks the ticket row status before writing, so a PUT against an `aborting` upload_id 404s. Either way, no leak. |
| R2 | User clicks Cancel while `completeMultipart` is in flight. | Resolved by status guards. `completeMultipart` runs `UPDATE … SET status='completing' WHERE status='pending'`; concurrent `abortMultipart` runs `UPDATE … SET status='aborting' WHERE status='pending'`. SQLite serialises these; exactly one wins. **Complete wins by design** (rationale below); abort returns `already_completed`. |
| R3 | Sweep transitions a ticket to `aborting` while user is calling `complete`. | Same mechanism as R2. The Phase 1.5 sweep code does `UPDATE … SET status='aborting' WHERE status='pending'` and the complete path does `UPDATE … SET status='completing' WHERE status='pending'`. The loser sees `changes === 0`, re-loads, finds the unexpected status, and returns the appropriate outcome (`wrong_state` for the loser). The user sees a failure; the bytes are gone (sweep aborted them); ticket is terminal. Acceptable: the ticket exceeded its TTL, the user took too long. |
| R4 | Network blip: user calls `abortMultipart` twice in quick succession. | First call: `pending → aborting → abortMultipart(storage) → expired`. Second call: status is now `expired`, returns `already_aborted`. Idempotent. If the first call is still running at the second call's arrival, the second sees `aborting`, falls through to retry the storage abort (idempotent on both backends), returns `aborted`. |
| R5 | S3 returns HTTP 200 with `<Error>` XML body on `CompleteMultipartUpload`. | Storage-agent's `s3.completeMultipart` MUST parse the XML body (the SDK doesn't always throw on this — AWS documents that S3 streams the response, may send 200 first, then write the error in the body). Treat any `<Error>` element as failure: throw a typed error that `upload-tickets.completeMultipart` catches and translates to `failed: storage_complete_failed`. The `completing → failed` transition fires; the session is *probably* gone on S3's side but might not be — the failed-path enqueues `pending_aborts` (reason `complete_failed`) so the sweep retries. |
| R6 | Attacker guesses an HMAC-signed part URL for a now-dead session and replays it. | Part-receive route does `SELECT id, status FROM upload_tickets WHERE upload_id = ?` before writing. Rejects with 404 if not found, or if `status NOT IN ('pending')` (note: `aborting` and `completing` are also closed — once we've started either teardown or completion, no new parts are accepted). HMAC alone is not enough; the ticket-row check is the disk-fill guard. See §7. |
| R7 | User initiates a multipart upload, then deletes the parent link before any part has uploaded. | `receive-links.remove` snapshots the in-flight multipart tickets, enqueues `pending_aborts`, CASCADE-deletes the rows, fires inline best-effort abort. S3 session goes away within a second (typical). If the inline abort fails, sweep Phase 1.7 drains it within `intervalSeconds`. Subsequent part PUTs from the still-running browser fail at the route layer (R6) — the upload_tickets row is gone, so the part route can't validate. |
| R8 | Two concurrent uploaders init two multipart sessions on the same receive-link with `max_uploads=1`. | Both pass policy at init (uploads_so_far counted from `files`, which is still 0). Both upload all parts. First to call `completeMultipart` wins policy + creates the file row (`uploads_so_far` becomes 1). Second's `completeMultipart` re-runs policy, gets `quota_exhausted`. The second's storage session and uploaded parts are now orphan-from-the-app's-perspective; ticket stays `pending` until TTL, then Phase 1.5 aborts the storage session. Matches existing single-PUT semantics; no regression. |

### Why complete wins ties

R2's tie-break could go either way. Complete-wins rationale:
- The bytes already exist. Throwing them away to honour a half-second-late
  cancel is wasteful.
- Abort returning `already_completed` is honest: the upload **was**
  completed, just barely.
- The frontend UX is "Cancel clicked → progress shows aborted, but if you
  refresh you might see the file". This is the right behaviour — same as
  hitting Cancel on a download in any browser when bytes finished
  arriving milliseconds before the click.

The opposite policy (abort wins) requires `completeMultipart` to also
issue an `AbortMultipartUpload` after-the-fact and delete the freshly
created `file` row. More moving parts, no user benefit.

---

## 7. Security

### Local part-receive route

`PUT /api/storage/o/multipart/part/:uploadId/:partNumber` — mirrors the
existing PUT route in `routes/storage.ts`.

Hard requirements:

1. **HMAC signature** over `(method, uploadId, partNumber, exp, contentLength)`.
   `method` MUST be a distinct token (recommend `'PUT-PART'`) — see
   "Method-token distinctness" below.
2. **Signed `Content-Length`** is required (not optional). Without it the
   route cannot enforce the disk-fill guard. The init code path always
   includes it (the part size is known up front).
3. **Disk-fill DoS guard**: byte-count the incoming body, abort as soon as
   `bytesReceived > signedContentLength`. Copy the existing PUT route's
   `overrun` pattern exactly (lines 96-112 of `routes/storage.ts`).
4. **`Content-Length` header parity**: reject 403 on header mismatch with
   the signed value. Same as the existing PUT route.
5. **Ticket-row validation**: before writing, look up
   `SELECT id, status, expected_parts FROM upload_tickets WHERE upload_id = ?`.
   Reject 404 if no row exists. Reject 410 if `status NOT IN ('pending')`
   (the row exists but the session is closed — sweep / abort / complete
   already happened). Reject 400 if `partNumber > expected_parts`. This
   is the gate that prevents an attacker who has guessed an HMAC URL from
   writing to a long-dead session and wasting disk.

   This is a NEW invariant compared to the single-PUT route. The single-
   PUT route trusts HMAC alone because the signed URL expires in 5
   minutes and there's nothing to do with bytes written under a guessed
   key (the ticket row never gets `finalize`d — bytes are inert). Multipart
   sessions live longer (default 2h TTL) and the route is invoked many
   times per ticket, so HMAC-plus-row-check is the right boundary.
6. **Atomic write**: `<uploadId>/<partNumber>.part.tmp-<random>` → fsync
   → rename, identical to the single-PUT route's atomic-rename pattern.
   Re-uploads of the same part number overwrite cleanly (last-write-wins
   per part, matching S3 semantics).
7. **Per-part etag**: respond with `ETag: "<sha256-hex>"` header so the
   frontend can include the etag in its `completeMultipart` payload.
   Mirrors S3's `ETag` response on `UploadPart`.

### Method-token distinctness

`signing.ts`'s `CanonicalMethod` is currently `'PUT' | 'GET' | 'DELETE'`.
Multipart introduces a fourth, intentionally distinct from `PUT`:
`'PUT-PART'`. Two reasons:

1. **Replay resistance**: a presigned multipart-part URL for `key=
   receive/abc/.../foo` must NOT be replayable as `PUT /put/receive/abc/.../foo`
   (single-PUT route). Without distinct method tokens, the same canonical
   string `PUT\nreceive/abc/.../foo\n<exp>\n...\n<cl>\n` would verify on
   both routes — an attacker who captured a part URL could overwrite the
   final object directly. With `PUT-PART`, the canonical strings differ
   and signatures don't cross-validate.
2. **Key namespace separation**: a part URL signs `uploadId/partNumber`,
   not a free-form key. The route parser extracts uploadId+partNumber and
   builds the path locally; nothing the client supplies in the URL goes
   into a filesystem path. The HMAC structure binds the uploadId+partNumber
   pair to the signature so substituting either fails.

Update `CanonicalMethod` to `'PUT' | 'GET' | 'DELETE' | 'PUT-PART'`. The
canonical-string format stays positional; the `method` field just adopts
the new value when signing part URLs.

### Init-time size bounds

`initMultipart` enforces:
- `size > 0` — zero-byte multipart makes no sense; reject as
  `invalid_input: invalid_size`. (The `size === 0` case is small enough
  to go through single-PUT; if a frontend bug routes it to multipart,
  return the error rather than silently coping.)
- `size <= STORAGE_MAX_OBJECT_SIZE_BYTES` (see §9 for the recommended
  default). Reject as `invalid_input: size_too_large`.
- `size` is a finite integer (`Number.isInteger(size) && Number.isFinite(size)`).

Both single-PUT (`createForReceiveLink`) and multipart (`initMultipart`)
enforce the upper bound. Adding it to single-PUT is a tiny patch — share
the constant.

### Filename sanitisation

The multipart bucket-key prefix `receive/<linkId>/<ticketId>/<filename>`
reuses the existing `sanitizeFilename` helper from `upload-tickets.ts`
verbatim. No new sanitiser. Local parts live under `.multipart/<uploadId>/`
which is operator-generated and does not include user input — no path-
traversal surface.

### Rate-limiting init per receive-link code

Recommend: defer dedicated init rate-limiting to a follow-up issue. The
existing protections already in place are:
- Receive link `maxUploads` quota (caps the rate of *successful*
  multipart sessions per link).
- Receive link expiry (`expires_at`) caps the window.
- Receive link password gate when set.
- The presign TTL (default 5 min) limits how many valid part URLs an
  attacker who exfiltrated an init response can hold at once.

The remaining attack — repeatedly POST `multipart/init` against a public
receive-link code to chew up DB rows + open S3 sessions — is bounded by
the per-link `maxUploads` (when set) and by sweep Phase 1.5 (default 2h
TTL, then S3 session is freed). Without `maxUploads`, the rate is bounded
only by the public route's general rate-limiting layer if one exists.
File Harbor currently has no general rate-limiting middleware (verified:
no rate-limit library in `apps/server/package.json`); adding one is a
larger architectural decision that belongs in its own issue.

For v2: document the limitation in the README ("Set `max_uploads` on
public receive links to bound multipart-session creation"). Do NOT block
on this for issue #37.

### Send-link init

Already gated by `requireAdmin`. The admin can DOS themselves; that's
their prerogative. No additional rate-limit.

---

## 8. Observability

All logs use existing prefixes (`[upload-tickets]`, `[ticket-sweep]`,
`[storage]`) for grep continuity.

### Init

```
[upload-tickets] multipart-init { ticketId, key, partSize, expectedParts }
```

Logged at info level on successful `initMultipart` / `initMultipartForSendLink`.
Not logged on policy_rejected / invalid_input — those are the route layer's
business and would spam logs under an attack.

### Abort

```
[upload-tickets] multipart-abort { ticketId, key, reason: 'user'|'sweep'|'link-delete'|'complete-failed', phase: 'inline'|'sweep' }
```

Logged at info level on every successful storage-side abort. The `reason`
field maps to:
- `'user'` — `abortMultipart` called directly (route).
- `'sweep'` — Phase 1.5 (TTL expired).
- `'link-delete'` — `receive-links.remove` / `send-links.remove`. `phase`
  distinguishes the inline best-effort call from the sweep-Phase-1.7 drain.
- `'complete-failed'` — `completeMultipart` failed mid-flight and we're
  cleaning up the orphaned session.

### Complete

```
[upload-tickets] multipart-complete { ticketId, key, fileId, expectedParts, sizeBytes }
```

Logged on successful completion. Mirrors the implicit single-PUT success
(which has no log today; multipart adds one because the operation is
heavyweight enough to be worth a trace).

### Sweep

Existing `[ticket-sweep] pass complete { ... counters ... }` log line.
Extended counters appear automatically (see §5).

### Errors

`storage.abortMultipart` failures, `storage.completeMultipart` failures,
and `pending_aborts` drain failures all log at error level with the same
shape:
```
[upload-tickets] multipart-abort failed { ticketId, key, err }
[upload-tickets] multipart-complete failed { ticketId, key, err }
[ticket-sweep] pending_abort drain failed { id, err }
```

### Metrics surface (optional)

Out of scope for v2 — File Harbor has no metrics collector wired in. If
one is added, the per-pass counters and the sustained-failure counts on
`pending_aborts` are the obvious gauges.

---

## 9. Config additions

All new envs use the existing `parsePositiveIntSeconds` / paired helpers
(extend a `parsePositiveIntBytes` if cleaner). Add to `AppConfig.storage`
as a **shared sub-object** that applies to both backends — the multipart
threshold, part size, TTL, and max-object-size are policy decisions about
how File Harbor uses storage, not per-backend implementation details. The
discriminated union for `local` / `s3` continues to hold backend-specific
fields; the new fields hang off a shared peer.

```ts
export type StorageConfig = (S3StorageConfig | LocalStorageConfig) & {
  /** Shared multipart policy — applies to both backends. */
  multipart: MultipartConfig;
};

export interface MultipartConfig {
  /**
   * Threshold above which the frontend uses multipart instead of single-PUT.
   * Surfaced to the frontend via /api/config/upload. Default 100 MiB
   * matches the Cloudflare Tunnel Free body cap (the immediate motivator).
   */
  thresholdBytes: number;
  /**
   * Target part size in bytes. The server picks
   *   actualPartSize = max(partSizeBytes, ceil(totalSize / 10_000))
   * so any total size up to STORAGE_MAX_OBJECT_SIZE_BYTES fits in ≤10_000
   * parts (S3 hard limit). Default 16 MiB: comfortably under typical
   * tunnel body caps with parallelism headroom.
   */
  partSizeBytes: number;
  /**
   * How long a pending multipart session is allowed to sit before sweep
   * Phase 1.5 aborts it. Default 7200 (2 hours). Longer than presign TTL
   * because a multipart upload can legitimately take much longer than
   * the per-URL presign window (each PUT-PART URL is fresh).
   */
  ttlSeconds: number;
  /**
   * Hard ceiling on any single uploaded object — single-PUT or multipart.
   * Defaults differ by backend:
   *   - s3:    5 TiB         (S3 hard limit on a single object).
   *   - local: 50 GiB        (sensible default for a self-hoster; raises
   *                           to disk capacity by env if the operator
   *                           explicitly wants larger objects).
   *
   * Resolved at boot per backend; one number is exposed regardless.
   */
  maxObjectSizeBytes: number;
}
```

### Env vars

| Env                                | Default                                  | Notes                                          |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `STORAGE_MULTIPART_THRESHOLD_BYTES`| `100 * 1024 * 1024` (100 MiB)            | Surfaced to FE via `/api/config/upload`.        |
| `STORAGE_MULTIPART_PART_SIZE_BYTES`| `16 * 1024 * 1024` (16 MiB)              | Min 5 MiB (S3 rule, also used locally for parity). Reject < 5 MiB at boot. |
| `STORAGE_MULTIPART_TTL_SECONDS`    | `7200` (2 h)                             | Sweep Phase 1.5 aborts above this.              |
| `STORAGE_MAX_OBJECT_SIZE_BYTES`    | local: `50 * 2^30` (50 GiB) / s3: `5 * 2^40` (5 TiB) | Applies to both single-PUT and multipart. |

### Defaults rationale

- **100 MiB threshold**: matches the Cloudflare Tunnel Free plan body
  cap, which is the direct motivator. A 99 MiB upload uses single-PUT (still
  one round-trip), 101 MiB uses multipart. Operators on Pro / Business /
  Enterprise tunnels (200 MB / 500 MB / 5 GB caps) can raise it.
- **16 MiB part size**: well under the 100 MiB Free tunnel cap, gives 4x
  parallelism headroom on a multi-part upload before hitting the cap. S3
  minimum is 5 MiB; we set higher so per-request overhead stays a small
  fraction of part size.
- **2 hour TTL**: a 50 GiB upload at 25 Mbps = ~4.5 hours. That's too
  slow; we'd thrash sessions. But 2 hours covers the realistic LAN /
  fibre case (50 GiB at 100 Mbps = ~70 min). Operators on slow links can
  raise via env. Going much higher than 2 h means abandoned sessions sit
  longer in S3 before being charged-then-aborted.
- **50 GiB max object size (local)**: a self-hosted instance on commodity
  hardware probably has a small data volume. 50 GiB is "I uploaded a few
  big media files" territory. Operators with bigger appetites set the env.
- **5 TiB max object size (S3)**: the S3 hard limit. No reason to be
  smaller — the bucket is the customer's problem.

### Boot validation

- `STORAGE_MULTIPART_PART_SIZE_BYTES >= 5 * 1024 * 1024` — S3 rule, local
  matches.
- `STORAGE_MAX_OBJECT_SIZE_BYTES > STORAGE_MULTIPART_THRESHOLD_BYTES` —
  otherwise the threshold is unreachable.
- `STORAGE_MULTIPART_PART_SIZE_BYTES * 10_000 >= STORAGE_MAX_OBJECT_SIZE_BYTES`
  — ensures the size-to-part-count math never exceeds S3's 10 000-part cap
  with the default part size. (If an operator picks a 50 GiB object size
  with a 1 MiB part size, the math fails at init; better to catch at boot.)

### Frontend surface

`/api/config/upload` already exists in scope per the goal-analysis. It
returns at minimum `{ multipartThresholdBytes }`. Recommend also exposing
`partSizeBytes` so the frontend can pre-compute `expectedParts` and avoid
a round-trip ("does this fit in <X> parts at <Y> concurrency?"). Both
values are non-sensitive — they're operator-tuning knobs, not secrets.

---

## Cross-references for other agents

- **Schema agent**: needs to add `protocol`, `upload_id`, `part_size`,
  `expected_parts`, `abort_attempts` columns to `upload_tickets`; add
  `completing` and `aborting` to the status check constraint; create the
  `pending_aborts` table from §4; create the migration as `0007_*.sql`
  (or whatever number is next).
- **Storage agent**: must guarantee idempotent `abortMultipart` on both
  backends, must parse 200-with-`<Error>` body in `s3.completeMultipart`
  (§6 R5), must implement the `PUT-PART` HMAC method token (§7).
- **Route-layer agent**: maps the new outcomes to HTTP status codes
  following the existing public-route convention (404 for `link_not_found`
  / `ticket_not_found`, 403 for policy_rejected by password, 410 for
  `wrong_state` on a closed session, 400 for `invalid_input`, 200 for
  success). The part-receive route is in this agent's surface (route is
  defined here in shape, implementation lives with the route agent).
- **Frontend agent**: implements dispatch on `STORAGE_MULTIPART_THRESHOLD_BYTES`
  (fetched from `/api/config/upload`), per-part retry, paginated
  `getMultipartPartUrls` calls when `nextPartNumber` is set, calls
  `abortMultipart` on user cancel + on tab close (`beforeunload` best-
  effort `navigator.sendBeacon`).
