# Frontend Multipart Upload Plan — Issue #37

Browser-side plan for the multipart upload path. Scope: `apps/web/src/lib/upload.ts`,
`apps/web/src/lib/api.ts`, the public receive page, and the two admin send-link pages.
Reads server-issued config at runtime; no rebuild needed to retune threshold or part size.

---

## 1. `apps/web/src/lib/upload.ts` extension — shape & signatures

**Decision: keep `uploadFileWithProgress` untouched, add `uploadFileMultipart`, expose a
top-level `uploadFile` dispatcher.** Rationale:

- Single-PUT call sites can keep calling `uploadFileWithProgress` directly — zero diff in
  cases where the caller knows the file is small.
- The two functions are independently testable; the existing module comment ("only place
  we drop back to XHR") stays accurate.
- The dispatcher is a small pure switch; no hidden control flow in the helper that
  already works.

The pages we touch (`PublicReceivePage`, `NewSendLinkPage`, `SendLinkDetailPage`) all
migrate to the dispatcher because they don't know the file size at code-write time.

### Types (added at the top of the module)

```ts
/** Whole-upload progress, summed across parts for the multipart case. */
export interface UploadProgress { loaded: number; total: number }

export type UploadResult =
  | { kind: 'single'; status: number; ok: boolean }
  | { kind: 'multipart'; completed: true };

/** Page-supplied API hooks; injects public vs. admin endpoints into the helper. */
export interface MultipartDeps {
  /**
   * Open the session. Returns either an inline `urls` array (small/medium files) or a
   * lazy `paginated` source for >1000 parts. See section 6 for the windowed fetcher.
   */
  init(): Promise<{
    ticketId: string;
    uploadId: string;
    partSize: number;
    expectedParts: number;
    urls:
      | { kind: 'inline'; urls: PartUrl[] }
      | { kind: 'paginated'; fetchUrls: (from: number, to: number) => Promise<PartUrl[]> };
  }>;
  /** Server-side CompleteMultipartUpload + finalize. Returns the finalize Outcome. */
  complete(parts: PartEtag[]): Promise<FinalizeOutcome>;
  /** Best-effort server abort. Called on cancel, on permanent failure, or on init-then-cancel. */
  abort(): Promise<void>;
}

export interface PartUrl { partNumber: number; url: string }
export interface PartEtag { partNumber: number; etag: string }

export interface SinglePutDeps {
  /** Existing single-PUT mint → returns the presigned URL. */
  presign(): Promise<{ url: string }>;
  /** Existing finalize call (same Outcome the page already handles). */
  finalize(): Promise<FinalizeOutcome>;
}

export interface UploadFileInput {
  file: File;
  contentType: string;
  /** Server-supplied threshold (bytes). File > threshold → multipart. */
  threshold: number;
  single: SinglePutDeps;
  multipart: MultipartDeps;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

export async function uploadFile(input: UploadFileInput): Promise<UploadResult>;
export async function uploadFileMultipart(input: {
  file: File;
  contentType: string;
  deps: MultipartDeps;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<UploadResult>;
```

`uploadFile` is the dispatcher: `file.size > threshold ? uploadFileMultipart(...)
: uploadFileWithProgress(...) wrapped to return UploadResult.kind='single'`. The
single-PUT branch also calls `single.presign()` + `single.finalize()` inside the
helper so both branches have the same "give me a file, get me a settled upload"
contract; pages don't need to know which path ran.

(Pages that want raw control — currently none — can still call
`uploadFileWithProgress` directly.)

---

## 2. Part-upload state machine

States, with the trigger for each transition:

| From | To | Trigger |
|---|---|---|
| `idle` | `initializing` | `uploadFileMultipart` called |
| `initializing` | `uploading-parts` | `deps.init()` resolves with `{ uploadId, urls }` |
| `initializing` | `aborting` | `signal.abort()` fires (or `init()` rejects) |
| `uploading-parts` | `completing` | last pending part settles 2xx, queue drained |
| `uploading-parts` | `aborting` | `signal.abort()`, OR any worker hits a permanent failure (4xx, or >max-retries) |
| `completing` | `completed` | `deps.complete(parts)` resolves with `kind: 'ok' & status: 'completed'` |
| `completing` | `failed` | `deps.complete()` resolves with `failed` / `policy_rejected` / `error` |
| `aborting` | `failed` | `deps.abort()` settles (success OR timeout — section 5) |
| any non-terminal | `failed` | unhandled exception |

`completed` and `failed` are terminal; the helper's promise resolves/rejects from there.
The state is internal to the helper (not exposed); pages observe the result via the
returned `Promise` and `onProgress` events. Pages already model their own phase
(`uploading` vs `finalizing`); this internal state machine is the helper's bookkeeping.

---

## 3. Concurrency + retry

### Constants & env

```ts
// Module-top, NaN-guarded. Mirror this pattern for any future VITE_* config.
const MULTIPART_CONCURRENCY = (() => {
  const raw = import.meta.env.VITE_MULTIPART_CONCURRENCY;
  const n = Number.parseInt(raw ?? '4', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();

const PART_MAX_RETRIES = 3;
const PART_RETRY_BASE_MS = 1000; // 1s, 2s, 4s with jitter
```

`vite/client` types are already in `tsconfig.json` (`"types": ["vite/client"]`), so
`import.meta.env` is typed. Document the new var in the README or `.env.example` when the
backend planner adds the env section.

### Producer / consumer

- The "queue" is a shared counter `nextPartIndex` (0-based) and `expectedParts` bound.
  No real queue object; workers atomically read-and-increment via `const idx =
  nextPartIndex++` (single-threaded JS guarantees atomicity).
- `Math.min(MULTIPART_CONCURRENCY, expectedParts)` workers are spawned as parallel
  `async` tasks.
- Each worker loop: `while (nextPartIndex < expectedParts && !aborted) { idx =
  nextPartIndex++; await uploadPart(idx); }`.
- `uploadPart(idx)` resolves the URL (inline lookup or paginated window — section 6),
  PUTs the slice via XHR with per-part progress, returns the ETag on 2xx, records into
  the committed map. On permanent failure: flip an `aborted` flag, reject the outer
  promise, and let the abort path (section 5) tear in-flight XHRs.

### Part slice formula

```ts
const start = idx * partSize;
const end   = Math.min(start + partSize, file.size);
const blob  = file.slice(start, end);
const partNumber = idx + 1; // S3 part numbers are 1-based
```

The last part is `file.size - (expectedParts - 1) * partSize` bytes. Server signs
`expectedParts`; client honors it. Mismatch → server's length-validation at complete
fails the upload (and is the canonical signal — section 11).

### Per-part retry

For each part, retry up to `PART_MAX_RETRIES = 3` times with exponential backoff
`1000ms · 2^attempt` and ±20% jitter (`base * (0.8 + Math.random() * 0.4)`).

Retry **only** on:
- network error (XHR `onerror` / `ontimeout`),
- HTTP 5xx,
- HTTP 408 / 429 (the canonical transient codes; harmless to include).

Do **not** retry on any other 4xx — those are permanent (signature mismatch, expired
URL, bad length, etc). Surface immediately so the user sees a real error rather than
a long stall.

On a permanent part failure: flip `aborted = true`, signal the user-supplied `signal`
(via an internal `AbortController` derived from it) so other workers' in-flight XHRs
are torn down, call `deps.abort()` (subject to the 5s race in section 5), reject the
overall promise.

### Reset between retries

On retry: clear that part's `inFlightBytes` entry to 0 *before* opening the next XHR;
the next `onprogress` will repopulate it. See section 4 for why this is structurally
safe.

---

## 4. Progress aggregation

### Data structure — two maps, not one

```ts
const committedBytes = new Map<number, number>(); // partNumber → bytes (set once, on 2xx)
const inFlightBytes  = new Map<number, number>(); // partNumber → bytes (live during PUT)
```

- `committedBytes[p]` is set **only** when XHR settles 2xx. Value = the *real* part
  byte count, computed as `end - start` from the slice formula above (NOT `partSize`,
  which would over-count the last part).
- `inFlightBytes[p]` is set on every `xhr.upload.onprogress` and reset to 0 at the
  start of each (retry) attempt. Cleared (deleted) once the part is committed.

### Reported progress

```ts
let loaded = 0;
for (const v of committedBytes.values()) loaded += v;
for (const [p, v] of inFlightBytes) if (!committedBytes.has(p)) loaded += v;
onProgress?.({ loaded, total: file.size });
```

The `!committedBytes.has(p)` guard is the **anti-"stuck at 99%" structural guarantee**:
once a part is committed, its in-flight reading is ignored even if `onprogress` fires
late, and a retry's reset of `inFlightBytes[p]=0` can never subtract from already-
committed bytes. The bug is impossible by construction, not by discipline.

### Throttling

The XHR progress event fires at ~50–250 Hz on a fast LAN. React re-renders at that rate
are wasteful. Throttle the user-supplied `onProgress` to ≤10 Hz with a 100 ms trailing
timer:

```ts
let pending = false;
let lastFlush = 0;
function scheduleFlush() {
  const now = Date.now();
  const elapsed = now - lastFlush;
  if (elapsed >= 100) { flush(); return; }
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; flush(); }, 100 - elapsed);
}
```

Use `setTimeout` (not `requestAnimationFrame`) — rAF stops firing in background tabs,
which would freeze the progress UI when the user switches away from the upload tab.

**Always flush an unthrottled final `{ loaded: file.size, total: file.size }` on
completion** so the bar lands at 100%, regardless of the throttle's timing.

---

## 5. AbortSignal plumbing

The helper owns an internal `AbortController` (`internalAc`) that:
1. Aborts when the caller's `signal` aborts (`input.signal?.addEventListener('abort',
   () => internalAc.abort(), { once: true })`).
2. Aborts when any worker hits a permanent failure (so the other in-flight XHRs die).

Every XHR passes `internalAc.signal` down to `uploadFileWithProgress`-style logic.
The existing pattern (`signal.addEventListener('abort', () => xhr.abort(), { once: true })`)
already handles the per-XHR abort.

### On abort

```ts
async function performAbort() {
  // 1. In-flight XHRs are already aborted via internalAc.signal listener wiring.
  // 2. Best-effort server abort with a 5s ceiling so a hung server can't block UI.
  await Promise.race([
    deps.abort().catch(() => {}),       // swallow — sweep is the safety net
    new Promise<void>((r) => setTimeout(r, 5000)),
  ]);
  // 3. State → 'failed' (or 'cancelled' from the page's POV).
}
```

We `await` the abort race (rather than `keepalive` fire-and-forget like
`confirmDownloadTicket`) because the user is still on the page in the cancel case —
they want the "cancelled" confirmation. Only fall back to `keepalive: true` if the
page is unloading (`beforeunload`); for v2 we leave that as a future addition (the
server-side TTL sweep handles it).

### Edge: aborted-before-init-returns

If the user cancels while `deps.init()` is still in flight:
- The init promise itself is wrapped in an abort-aware race; on abort, we still
  `await init()` to completion (it doesn't know how to cancel mid-call), and if it
  resolves with a `uploadId`, we **still call `deps.abort()`** on that uploadId before
  declaring failed.
- If `init()` rejects, no abort call needed — the server never created a session.

### Edge: init returned, zero parts uploaded

Same as above — still call `deps.abort()` with the `uploadId`. The server's abort
endpoint must be idempotent against "no parts received yet" (backend planner's
contract).

---

## 6. Part-URL fetching for very large files

If `init` returns `{ kind: 'paginated', fetchUrls }`, the helper keeps a **sliding
window** of pre-fetched URLs ahead of the consumer pointer.

### Parameters

```ts
const URL_WINDOW_SIZE = 2 * MULTIPART_CONCURRENCY; // urls held ahead of next consumer
const URL_FETCH_PAGE = Math.max(URL_WINDOW_SIZE, 64); // fetch this many per call
```

### Algorithm

- A single `Map<partNumber, string>` holds resolved URLs.
- One in-flight `prefetchPromise: Promise<void> | null` at a time — workers that need
  an as-yet-unfetched URL `await prefetchPromise ?? (prefetchPromise =
  refillWindow())`. The single-flight guard prevents N workers from issuing N
  duplicate page fetches.
- `refillWindow()` looks at `nextPartIndex` and fetches `[nextPartIndex+1,
  nextPartIndex+URL_FETCH_PAGE]` (clamped to `expectedParts`), populates the Map,
  clears the URL entries that are now strictly behind the window head, nulls
  `prefetchPromise`.

The inline-`urls` case skips this entirely — the Map is preloaded from the array at
init.

(Implementation note: prune URLs *behind* the head so the Map doesn't grow unbounded
for huge files. URLs for completed parts are useless.)

---

## 7. API client wrappers in `apps/web/src/lib/api.ts`

Add the following typed functions. Follow the existing `Outcome` discriminated-union
pattern; `readErrorBody` + `asPolicyRejection` already provide the building blocks.

### Shared types

```ts
export interface PartUrl { partNumber: number; url: string }
export interface PartEtag { partNumber: number; etag: string }

export interface MultipartInitResponse {
  ticketId: string;
  uploadId: string;
  partSize: number;
  expectedParts: number;
  /** Inline `urls` for small N; `paginated: true` when N > 1000 (server's threshold). */
  urls: { kind: 'inline'; urls: PartUrl[] } | { kind: 'paginated' };
}

export type CreateMultipartUploadTicketOutcome =
  | { kind: 'ok'; value: MultipartInitResponse }
  | { kind: 'policy_rejected'; reason: PolicyRejection }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };
```

### Public surface (mirror admin send-link versions, same shape)

```ts
export async function createMultipartUploadTicket(
  code: string,
  payload: { filename: string; contentType: string; size: number; password?: string | null },
): Promise<CreateMultipartUploadTicketOutcome>;

// Pagination outcome diverges from init — ticket already passed policy gates at init,
// so no policy_rejected branch is possible here.
export type FetchMultipartPartUrlsOutcome =
  | { kind: 'ok'; value: PartUrl[] }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export async function fetchMultipartPartUrls(
  ticketId: string,
  from: number,
  to: number,
): Promise<FetchMultipartPartUrlsOutcome>;

// Same FinalizeOutcome union the single-PUT finalize returns.
export async function completeMultipartUploadTicket(
  ticketId: string,
  payload: { parts: PartEtag[]; password?: string | null },
): Promise<FinalizeOutcome>;

// Fire-and-forget with `keepalive: true`, mirroring confirmDownloadTicket. We
// don't surface errors — sweep is the safety net.
export async function abortMultipartUploadTicket(ticketId: string): Promise<void>;
```

### Admin send-link symmetric versions

```ts
export async function addMultipartFileToSendLink(
  sendLinkId: string,
  payload: { filename: string; contentType: string; size: number },
): Promise<MultipartInitResponse>;          // admin path — no policy gate, raw response
export async function fetchSendLinkMultipartPartUrls(
  sendLinkId: string, ticketId: string, from: number, to: number,
): Promise<FetchMultipartPartUrlsOutcome>;
export async function completeSendLinkMultipartUpload(
  sendLinkId: string, ticketId: string, parts: PartEtag[],
): Promise<FinalizeOutcome>;
export async function abortSendLinkMultipartUpload(
  sendLinkId: string, ticketId: string,
): Promise<void>;
```

(Exact URL shapes match the backend route plan; admin URLs are gated by Better Auth's
session cookie via `credentials: 'include'` like existing admin calls.)

### Cross-cutting: ETag extraction & CORS contract

This is a backend contract the frontend depends on; flag to the backend planner:

- S3 mode: each `UploadPart` response carries `ETag` as a **response header**. XHR must
  read `xhr.getResponseHeader('ETag')`. S3 / R2 / MinIO bucket CORS config MUST include
  `Access-Control-Expose-Headers: ETag` or the cross-origin call returns `null` and the
  whole `complete` step silently breaks.
- Local mode: HMAC-signed PUT to `/api/storage/o/multipart/part/...` — server should
  also return ETag in a response header (consistent contract). If it returns JSON
  instead, the helper falls back to parsing the response body.

Frontend helper: `xhr.getResponseHeader('ETag') ?? parseEtagFromJsonBody(xhr.responseText)`.
A `null` ETag is a hard failure (the part is unusable for `CompleteMultipartUpload`).

### Cross-cutting: Content-Type on part PUTs

Single-PUT signs Content-Type; **multipart parts typically do NOT**, because S3's
`UploadPart` presign doesn't include it. Default behavior: **do not set Content-Type
on part XHRs.** This matches the standard S3 contract — adding the header when not
signed → `SignatureDoesNotMatch`. Backend planner owns confirming both providers
agree on this contract.

### Field naming

Use `expectedParts` consistently across TS types (matches the planned
`expected_parts` schema column). The issue uses both `partCount` and `expectedParts`;
goal-analysis canonicalizes on `expected_parts`. Cross-check with the backend
planner's doc to lock the field name.

---

## 8. Config-from-server endpoint

`GET /api/config/upload` → `{ multipartThresholdBytes, multipartPartSize,
multipartTtlSeconds }`. Public endpoint (no auth) so it works for `PublicReceivePage`.

### Caching: module-level singleton, lazy-memoized

```ts
// apps/web/src/lib/upload-config.ts (new file — single-value config bag)
export interface UploadConfig {
  multipartThresholdBytes: number;
  multipartPartSize: number;
  multipartTtlSeconds: number;
}

let cached: Promise<UploadConfig> | null = null;

export function getUploadConfig(): Promise<UploadConfig> {
  return (cached ??= fetch('/api/config/upload').then((r) => {
    if (!r.ok) throw new Error(`upload config: ${r.status}`);
    return r.json() as Promise<UploadConfig>;
  }));
}

/** Test-only escape hatch. */
export function _resetUploadConfigCacheForTests(): void { cached = null; }
```

**Lazy first-call**, not eager on app mount. Pages `await getUploadConfig()` once
before showing the file picker. The shared promise dedupes parallel callers on first
load. A second new file (rather than appending to `upload.ts`) keeps the helper
free of fetch concerns.

(A React context is overkill for one immutable read-only triple; a module singleton
is the cleanest equivalent.)

---

## 9. PublicReceivePage integration

Minimal diff. Pre-fetch the config on mount (alongside `getPublicReceiveLink`), gate
the file picker on both. Add a Cancel button visible during the upload phases that
fires an `AbortController` plumbed into `uploadFile`.

### State additions

```ts
const [config, setConfig] = useState<UploadConfig | null>(null);
const abortRef = useRef<AbortController | null>(null);
// extend phase union: ... | 'cancelling' | 'cancelled'
```

### Effect

```ts
useEffect(() => {
  let cancelled = false;
  Promise.all([getPublicReceiveLink(code), getUploadConfig()])
    .then(([m, c]) => { if (!cancelled) { setMeta(m); setConfig(c); } })
    .catch((err) => { if (!cancelled) setMetaError(...); });
  return () => { cancelled = true; };
}, [code]);
```

### Upload call site (replaces lines ~95–108)

```ts
abortRef.current = new AbortController();
const result = await uploadFile({
  file,
  contentType: file.type || 'application/octet-stream',
  threshold: config!.multipartThresholdBytes,
  single: {
    presign: async () => ({ url: ticket.value.presignedPutUrl }),
    finalize: () => finalizeUploadTicket(ticket.value.ticketId,
      meta?.passwordRequired ? password : null),
  },
  multipart: {
    init: async () => {
      const out = await createMultipartUploadTicket(code, {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        password: meta?.passwordRequired ? password : null,
      });
      if (out.kind !== 'ok') { handleRejection(out); throw new Error('init-rejected'); }
      // Bind ticketId into the closure for complete/abort below.
      mpTicketIdRef.current = out.value.ticketId;
      return {
        ticketId: out.value.ticketId,
        uploadId: out.value.uploadId,
        partSize: out.value.partSize,
        expectedParts: out.value.expectedParts,
        urls: out.value.urls.kind === 'inline'
          ? { kind: 'inline', urls: out.value.urls.urls }
          : { kind: 'paginated', fetchUrls: async (from, to) => {
              const r = await fetchMultipartPartUrls(out.value.ticketId, from, to);
              if (r.kind !== 'ok') throw new Error('fetch-urls-failed');
              return r.value;
            } },
      };
    },
    complete: (parts) => completeMultipartUploadTicket(mpTicketIdRef.current!, {
      parts, password: meta?.passwordRequired ? password : null,
    }),
    abort: () => abortMultipartUploadTicket(mpTicketIdRef.current!),
  },
  onProgress: ({ loaded, total }) => {
    if (total > 0) setProgress(Math.round((loaded / total) * 100));
  },
  signal: abortRef.current.signal,
});
```

The two existing call sites (`uploadFileWithProgress` + `finalizeUploadTicket`)
collapse into the single `uploadFile` call because `SinglePutDeps.finalize` is run
internally for the small-file branch. Phase transitions in the page stay the same;
the helper's internal state isn't surfaced.

### JSX: Cancel button

```tsx
{(phase === 'minting' || phase === 'uploading' || phase === 'finalizing') && (
  <button type="button" onClick={() => {
    abortRef.current?.abort();
    setPhase('cancelling');
  }}>
    Cancel upload
  </button>
)}
{phase === 'cancelled' && <p className="muted">Upload cancelled.</p>}
```

---

## 10. Admin pages integration

### NewSendLinkPage

The per-file loop body (currently lines ~96–131) reduces to one `uploadFile` call per
file, with admin-side deps:

```ts
await uploadFile({
  file, contentType, threshold: config.multipartThresholdBytes,
  single: {
    presign: async () => {
      const ticket = await addFileToSendLink(link.id, { filename: file.name, contentType, size: file.size });
      ticketIdRef.current = ticket.ticketId;
      return { url: ticket.presignedPutUrl };
    },
    finalize: () => finalizeUploadTicket(ticketIdRef.current!, null),
  },
  multipart: {
    init: async () => {
      const r = await addMultipartFileToSendLink(link.id, { filename: file.name, contentType, size: file.size });
      ticketIdRef.current = r.ticketId;
      return { ...r, urls: r.urls.kind === 'inline' ? r.urls
        : { kind: 'paginated', fetchUrls: (f, t) =>
            fetchSendLinkMultipartPartUrls(link.id, r.ticketId, f, t).then(o => {
              if (o.kind !== 'ok') throw new Error('fetch-urls-failed'); return o.value; }) } };
    },
    complete: (parts) => completeSendLinkMultipartUpload(link.id, ticketIdRef.current!, parts),
    abort: () => abortSendLinkMultipartUpload(link.id, ticketIdRef.current!),
  },
  onProgress: ({ loaded, total }) => setProgress(total > 0 ? Math.round(loaded / total * 100) : 0),
  signal: abortRef.current?.signal,
});
```

Serial-by-file is preserved (admin UX preference per the existing comment). The
Cancel button cancels the **current** file; the loop honors the cancel by throwing
out of the helper.

### SendLinkDetailPage

The "add another file" UX isn't surfaced today (per existing comment: kept for #12+).
When wired up, it uses the same shape — bound to the existing `sendLinkId` from
`useParams`. Nothing structurally different; the dispatcher does the heavy lifting.

Pre-fetch `getUploadConfig()` once at page mount (alongside `getSendLink`) and gate
the upload UI on its presence. The shared module singleton means the second mount of
either admin page during a session is free.

---

## 11. Edge cases

- **Cancelled before init returns.** The internal abort controller fires the abort
  listener; the in-flight `init()` is still awaited (no cancellation mechanism in
  `fetch` here without restructuring; we accept the wait). If it resolves with a
  uploadId, we still call `deps.abort()` with that id before propagating the cancel.
  If it rejects, no server abort needed.
- **Browser closes mid-upload.** Out of scope per the issue (cross-session
  resumability needs IndexedDB). The server-side TTL sweep
  (`STORAGE_MULTIPART_TTL_SECONDS`, default 2h) is the safety net for both S3 and
  local backends.
- **File modified between init and upload (size changed).** Browsers don't surface
  this reliably; the `File` reference points at the OS file by handle and may read
  newer bytes on `.slice()`. We proceed and rely on the server's length-validation at
  `complete` time to fail the upload. Caller sees a `FinalizeOutcome` with
  `status: 'failed'`.
- **Inline-URLs response for files just under the pagination threshold.** Handled
  uniformly: the inline-URL Map is the same data structure the paginated path
  populates; no special-case in workers.
- **Empty file (`size === 0`).** Will be below `multipartThresholdBytes` (default
  100 MiB) — dispatched to single-PUT. Multipart path never sees a zero-byte file
  (S3 requires `expectedParts >= 1` with the last/only part allowed below the 5 MiB
  floor, but we don't exercise that here).
- **ETag header missing on a successful PUT.** Treated as a permanent failure for
  that part — no retry, abort the whole upload. Caused by missing
  `Access-Control-Expose-Headers: ETag` on the bucket; flagged as a backend
  contract requirement (section 7).
- **Server-side rejection at `complete` with a policy reason (e.g. `quota_exhausted`
  raced).** Returned as `FinalizeOutcome.kind === 'policy_rejected'`; page handles
  it the same way it already handles single-PUT finalize rejections.
