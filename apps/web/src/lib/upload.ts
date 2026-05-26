/**
 * Browser-side direct-to-S3 upload via XHR.
 *
 * `fetch` doesn't expose upload progress, and `Request`'s ReadableStream
 * upload progress is still patchy across browsers. XHR `upload.onprogress`
 * is the only path that's reliable today, so this is the one place we drop
 * back to XHR — every other network call is `fetch`.
 *
 * The `Content-Type` header MUST match what the server signed into the
 * presigned PUT (we sign the claimed type in `upload-tickets.createForReceiveLink`).
 * Mismatch → bucket rejects with `SignatureDoesNotMatch`. That's by design:
 * a wrong-type upload should be a hard failure, not a silent record.
 */

export interface PresignedUploadInput {
  url: string;
  file: File;
  contentType: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

export interface PresignedUploadResult {
  status: number;
  ok: boolean;
}

export function uploadFileWithProgress(
  input: PresignedUploadInput,
): Promise<PresignedUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', input.url, true);
    xhr.setRequestHeader('Content-Type', input.contentType);

    xhr.upload.onprogress = (e) => {
      if (input.onProgress && e.lengthComputable) {
        input.onProgress(e.loaded, e.total);
      }
    };

    xhr.onload = () => {
      // 2xx is success. The body is empty on success for S3 PUT; we ignore it.
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300 });
    };

    xhr.onerror = () => {
      reject(new Error(`Network error during upload (status=${xhr.status})`));
    };

    xhr.onabort = () => {
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    if (input.signal) {
      if (input.signal.aborted) {
        xhr.abort();
        return;
      }
      input.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(input.file);
  });
}

// =============================================================================
// Multipart upload — types
// =============================================================================

/**
 * Aggregated upload progress reported to the caller. For multipart this is the
 * sum of bytes committed (parts that returned 2xx) plus bytes in-flight from
 * `xhr.upload.onprogress` for parts not yet committed. See `uploadFileMultipart`
 * for the two-map structure that makes the "stuck at 99%" bug impossible by
 * construction.
 */
export interface UploadProgress {
  loaded: number;
  total: number;
}

/** A presigned PUT URL bound to a single part of a multipart upload. */
export interface PartUrl {
  partNumber: number;
  url: string;
}

/**
 * A successfully-uploaded part's identity for the `CompleteMultipartUpload`
 * call. The server validates the `etag` matches what storage recorded.
 */
export interface PartEtag {
  partNumber: number;
  etag: string;
}

/**
 * Provider for the single-PUT dispatch path. The dispatcher calls `presign()`
 * first to get the URL + ticketId, then runs `uploadFileWithProgress`, then
 * calls `finalize(ticketId)` to surface the server-side outcome.
 *
 * Kept generic so the same dispatcher serves both the public receive-link flow
 * and the admin send-link flow — the page picks the endpoint, this module
 * just orchestrates.
 */
export interface SinglePutDeps {
  /** Mint a presigned PUT URL for the whole file. Returns the URL + ticketId. */
  presign(): Promise<{ presignedPutUrl: string; ticketId: string }>;
  /** Finalize after the upload completes; surfaces server-side outcome. */
  finalize(ticketId: string): Promise<UploadFinalizeOutcome>;
}

/**
 * Provider for the multipart dispatch path. All four methods are injected so
 * `uploadFileMultipart` has zero coupling to `api.ts`; the page wires the
 * concrete endpoints (public vs admin) into each method.
 */
export interface MultipartDeps {
  /**
   * Initialize a multipart session. Returns ticketId, uploadId, partSize,
   * expectedParts, and the first batch of part URLs (server caps at 100 inline,
   * with `paginated=true` flagging that more must be fetched).
   */
  init(): Promise<MultipartInitResult>;
  /**
   * Fetch a window of part URLs (paginated mode). `from`/`to` are 1-based,
   * inclusive. Server caps `to - from + 1` at 100.
   */
  fetchPartUrls(ticketId: string, from: number, to: number): Promise<PartUrl[]>;
  /** Finalize the multipart upload with the completed parts list. */
  complete(ticketId: string, parts: PartEtag[]): Promise<UploadFinalizeOutcome>;
  /**
   * Best-effort abort. Fire-and-forget; never throws to the caller. The
   * helper additionally enforces a 5s ceiling and swallows errors — see
   * `uploadFileMultipart`'s abort path.
   */
  abort(ticketId: string): Promise<void>;
}

/**
 * Result of `MultipartDeps.init()`. `initialUrls` carries the first batch
 * (server returns up to 100 inline); `paginated` is true iff more URLs need
 * fetching via `fetchPartUrls`.
 */
export interface MultipartInitResult {
  ticketId: string;
  uploadId: string;
  partSize: number;
  expectedParts: number;
  /** Inline first batch of part URLs (server caps at 100). */
  initialUrls: PartUrl[];
  /** True iff more URLs need fetching via fetchPartUrls(). */
  paginated: boolean;
}

/**
 * Outcome of the finalize / complete call. Mirrors the server's discriminated
 * Outcome shape but is defined locally so `upload.ts` has no dependency on
 * `api.ts`. The wave-3 API wrappers translate their wire-level outcome into
 * this shape.
 */
export type UploadFinalizeOutcome =
  | { kind: 'ok' }
  | { kind: 'failed'; reason: string }
  | { kind: 'policy_rejected'; reason: string }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

/** Input for the `uploadFile` dispatcher. */
export interface UploadFileInput {
  file: File;
  contentType: string;
  /** File-size threshold (bytes). `file.size <= threshold` → single-PUT path. */
  threshold: number;
  /** Server-issued part size (bytes). Honoured for the multipart slice loop. */
  partSizeBytes: number;
  single: SinglePutDeps;
  multipart: MultipartDeps;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

/** Discriminated result so callers can tell which path actually ran. */
export type UploadResult =
  | { kind: 'single'; outcome: UploadFinalizeOutcome }
  | { kind: 'multipart'; outcome: UploadFinalizeOutcome };

// =============================================================================
// Multipart upload — constants
// =============================================================================

/**
 * Per-file part-upload parallelism. Tunable at build time via
 * `VITE_MULTIPART_CONCURRENCY`. NaN-guarded and clamped to `[1, 32]` so a
 * typo in the env can't take the page down or DoS the bucket.
 *
 * Default 4 is the established S3-ecosystem sweet spot — high enough to
 * saturate most home connections, low enough that a single-tab upload doesn't
 * starve the rest of the page.
 */
const MULTIPART_CONCURRENCY = (() => {
  const raw = Number(import.meta.env.VITE_MULTIPART_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 && raw <= 32 ? raw : 4;
})();

/** How many part URLs we want ahead of the assignment pointer. */
const URL_WINDOW_SIZE = 2 * MULTIPART_CONCURRENCY;
/** Server-side cap on `GET .../parts?from=&to=` per request (R6). */
const URL_FETCH_PAGE = 100;
/** Maximum retries per part on transient failure. */
const PART_RETRY_LIMIT = 3;
/**
 * Exponential backoff for per-part retries. Index = attempt number (0-based).
 * Real wait = entry ± 20% jitter to break thundering-herd retry waves.
 */
const PART_RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];
/** Ceiling on the best-effort server abort call; sweep is the safety net. */
const ABORT_CALL_TIMEOUT_MS = 5000;
/**
 * Throttle interval for `onProgress` callbacks. 10 Hz is plenty for a smooth
 * UI bar; XHR fires events at 50–250 Hz on a fast LAN and re-rendering at
 * that rate is wasteful.
 *
 * Uses `setTimeout`, NOT `requestAnimationFrame`: rAF pauses in background
 * tabs, which would freeze the progress UI as soon as the user switches away.
 */
const PROGRESS_THROTTLE_MS = 100;

// =============================================================================
// Multipart upload — public API
// =============================================================================

/**
 * Single-call dispatcher: decides single-PUT vs multipart by file size,
 * orchestrates the chosen path, and returns a discriminated outcome.
 *
 * The branch is `file.size <= threshold`: a zero-byte file (or any file at or
 * below the threshold) takes the single-PUT path. This matters because the
 * multipart spec requires `expectedParts >= 1` and the smallest part except
 * the last has a 5 MiB floor on S3.
 *
 * Single-PUT path: `presign()` → `uploadFileWithProgress` → `finalize()`. If
 * storage rejects the PUT (non-2xx), the dispatcher synthesises an `error`
 * outcome and skips `finalize` (the server has no ticket-side knowledge of
 * the failure; the sweep will mark the row failed on TTL).
 *
 * Multipart path: delegates to `uploadFileMultipart` (defined below).
 */
export async function uploadFile(input: UploadFileInput): Promise<UploadResult> {
  if (input.file.size <= input.threshold) {
    const { presignedPutUrl, ticketId } = await input.single.presign();
    let put: PresignedUploadResult;
    try {
      put = await uploadFileWithProgress({
        url: presignedPutUrl,
        file: input.file,
        contentType: input.contentType,
        onProgress: (loaded, total) => input.onProgress?.({ loaded, total }),
        signal: input.signal,
      });
    } catch (err) {
      return {
        kind: 'single',
        outcome: { kind: 'error', message: describeUploadError(err) },
      };
    }
    if (!put.ok) {
      return {
        kind: 'single',
        outcome: {
          kind: 'error',
          message: `Upload to storage failed (status=${put.status}).`,
        },
      };
    }
    const outcome = await input.single.finalize(ticketId);
    return { kind: 'single', outcome };
  }
  const outcome = await uploadFileMultipart(input);
  return { kind: 'multipart', outcome };
}

/**
 * Multipart upload state machine:
 *   initializing → uploading-parts → completing → completed | failed | aborting
 *
 * State is internal to the helper — pages observe via the returned promise and
 * `onProgress`. The two-map progress aggregation (committedBytes +
 * inFlightBytes, with a guard against double-counting) makes the classic
 * "stuck at 99% then jumps to 100" bug impossible by construction.
 *
 * Cancel / failure path: an internal `AbortController` is chained to
 * `input.signal`. Aborting tears in-flight part XHRs, then calls
 * `multipart.abort(ticketId)` with a 5s ceiling. The abort call NEVER throws
 * out of this function — the server-side TTL sweep is the safety net.
 *
 * Returns the outcome of `multipart.complete()` on success, or a synthesised
 * outcome (`failed` / `error`) on cancel / part failure / complete failure.
 */
export async function uploadFileMultipart(input: UploadFileInput): Promise<UploadFinalizeOutcome> {
  // -------------------------------------------------------------------------
  // Setup: abort plumbing
  // -------------------------------------------------------------------------
  const internalAc = new AbortController();
  const onExternalAbort = (): void => internalAc.abort();
  if (input.signal) {
    if (input.signal.aborted) {
      internalAc.abort();
    } else {
      input.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const cleanupExternalAbort = (): void => {
    input.signal?.removeEventListener('abort', onExternalAbort);
  };

  // -------------------------------------------------------------------------
  // initializing → uploading-parts
  // -------------------------------------------------------------------------
  if (internalAc.signal.aborted) {
    cleanupExternalAbort();
    return { kind: 'error', message: 'Upload cancelled.' };
  }

  let initResult: MultipartInitResult;
  try {
    initResult = await input.multipart.init();
  } catch (err) {
    cleanupExternalAbort();
    return { kind: 'error', message: `Multipart init failed: ${describeUploadError(err)}` };
  }

  // If the user cancelled while init was in flight, still abort the (now-open)
  // server session before propagating the cancel.
  if (internalAc.signal.aborted) {
    await runAbort(input.multipart, initResult.ticketId);
    cleanupExternalAbort();
    return { kind: 'error', message: 'Upload cancelled.' };
  }

  const { ticketId, partSize, expectedParts, initialUrls, paginated } = initResult;

  // -------------------------------------------------------------------------
  // Per-part state
  // -------------------------------------------------------------------------
  /** Next part number to assign to a worker (1-based). Atomically incremented. */
  let nextPartIndex = 1;
  /** Highest partNumber present in `partUrls`. Drives the prefetch heuristic. */
  let highestPartUrl = 0;
  /** Resolved part URLs. Pruned behind the assignment pointer to bound memory. */
  const partUrls = new Map<number, string>();
  for (const u of initialUrls) {
    partUrls.set(u.partNumber, u.url);
    if (u.partNumber > highestPartUrl) highestPartUrl = u.partNumber;
  }
  /** Single-flight guard for URL prefetch — N workers must NOT issue N fetches. */
  let urlFetchPromise: Promise<void> | null = null;

  /**
   * Sealed bytes per completed part (set once, on 2xx response). The
   * `inFlightBytes` reading for the same part is ignored once an entry exists
   * here — that's the structural anti-"stuck-at-99%" guarantee.
   */
  const committedBytes = new Map<number, number>();
  /**
   * Live xhr.upload progress per in-flight part. Reset to 0 at the start of
   * each (retry) attempt; deleted once committed.
   */
  const inFlightBytes = new Map<number, number>();
  /** ETags as parts complete. Pushed in completion order; sorted before `complete()`. */
  const completedParts: PartEtag[] = [];

  // -------------------------------------------------------------------------
  // Progress reporting (throttled)
  // -------------------------------------------------------------------------
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let progressPending = false;
  let lastProgressFlush = 0;
  const total = input.file.size;

  const flushProgress = (): void => {
    progressPending = false;
    progressTimer = null;
    lastProgressFlush = Date.now();
    if (!input.onProgress) return;
    let loaded = 0;
    for (const v of committedBytes.values()) loaded += v;
    for (const [p, v] of inFlightBytes) {
      // Guard: never double-count a part. If somehow `onprogress` fires after
      // the 2xx settle, `committedBytes.has(p)` shields the sum.
      if (!committedBytes.has(p)) loaded += v;
    }
    input.onProgress({ loaded, total });
  };

  const scheduleProgress = (): void => {
    if (!input.onProgress) return;
    const elapsed = Date.now() - lastProgressFlush;
    if (elapsed >= PROGRESS_THROTTLE_MS) {
      if (progressTimer !== null) {
        clearTimeout(progressTimer);
        progressTimer = null;
      }
      flushProgress();
      return;
    }
    if (progressPending) return;
    progressPending = true;
    progressTimer = setTimeout(flushProgress, PROGRESS_THROTTLE_MS - elapsed);
  };

  // -------------------------------------------------------------------------
  // URL prefetch (single-flight, sliding window)
  // -------------------------------------------------------------------------
  /**
   * Ensures the part URL for `partNumber` is resolved. If not present and
   * pagination is on, kicks off (or joins) a single in-flight prefetch.
   *
   * Heuristic for *when* to prefetch: trigger whenever the assignment pointer
   * is within `URL_WINDOW_SIZE` of `highestPartUrl`, OR when the URL we need
   * is missing outright. Simpler than tracking the lowest in-flight part —
   * avoids a full Map scan on every worker iteration.
   */
  const ensurePartUrl = async (partNumber: number): Promise<string> => {
    const have = partUrls.get(partNumber);
    if (have !== undefined) {
      // Opportunistically refill the window when we're near the edge so the
      // next worker doesn't block. Fire-and-forget; the next call awaits.
      if (
        paginated &&
        !urlFetchPromise &&
        partNumber + URL_WINDOW_SIZE > highestPartUrl &&
        highestPartUrl < expectedParts
      ) {
        triggerPrefetch();
      }
      return have;
    }
    if (!paginated) {
      throw new Error(`Part URL missing for partNumber=${partNumber} in inline mode.`);
    }
    if (!urlFetchPromise) triggerPrefetch();
    await urlFetchPromise;
    const after = partUrls.get(partNumber);
    if (after === undefined) {
      throw new Error(`Part URL still missing for partNumber=${partNumber} after prefetch.`);
    }
    return after;
  };

  const triggerPrefetch = (): void => {
    if (urlFetchPromise) return;
    const from = highestPartUrl + 1;
    if (from > expectedParts) return;
    const to = Math.min(from + URL_FETCH_PAGE - 1, expectedParts);
    urlFetchPromise = (async () => {
      try {
        const urls = await input.multipart.fetchPartUrls(ticketId, from, to);
        for (const u of urls) {
          partUrls.set(u.partNumber, u.url);
          if (u.partNumber > highestPartUrl) highestPartUrl = u.partNumber;
        }
      } finally {
        urlFetchPromise = null;
      }
    })();
  };

  // -------------------------------------------------------------------------
  // Worker loop
  // -------------------------------------------------------------------------
  const workerCount = Math.min(MULTIPART_CONCURRENCY, expectedParts);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(workerLoop());
  }

  async function workerLoop(): Promise<void> {
    while (!internalAc.signal.aborted) {
      // Atomic single-threaded JS read-and-increment — no lock needed.
      const partNumber = nextPartIndex;
      if (partNumber > expectedParts) return;
      nextPartIndex = partNumber + 1;

      const url = await ensurePartUrl(partNumber);

      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, input.file.size);
      const blob = input.file.slice(start, end);

      const etag = await uploadPartWithRetry(url, blob, partNumber);

      committedBytes.set(partNumber, blob.size);
      inFlightBytes.delete(partNumber);
      completedParts.push({ partNumber, etag });
      scheduleProgress();

      // Prune URLs behind the assignment pointer so the Map doesn't grow
      // unbounded for huge files. The current part is already committed; we
      // can drop everything ≤ partNumber.
      if (paginated) {
        for (const k of partUrls.keys()) {
          if (k <= partNumber) partUrls.delete(k);
        }
      }
    }
  }

  /**
   * Uploads one part with retry. Resets `inFlightBytes[partNumber]` to 0 at
   * the start of each attempt; the next `onprogress` repopulates. Returns the
   * ETag on success; throws on permanent failure (non-retryable status, or
   * retry budget exhausted, or missing ETag header — the last is unrecoverable
   * because `CompleteMultipartUpload` needs an ETag per part).
   */
  async function uploadPartWithRetry(url: string, blob: Blob, partNumber: number): Promise<string> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= PART_RETRY_LIMIT; attempt += 1) {
      if (internalAc.signal.aborted) {
        throw new DOMException('Upload aborted', 'AbortError');
      }
      inFlightBytes.set(partNumber, 0);
      try {
        const result = await uploadPartOnce(url, blob, partNumber);
        return result;
      } catch (err) {
        lastErr = err;
        if (internalAc.signal.aborted) throw err;
        if (!isRetryableError(err) || attempt === PART_RETRY_LIMIT) {
          throw err;
        }
        await delayWithJitter(getBackoffMs(attempt), internalAc.signal);
      }
    }
    // Loop exits only via return / throw; this is unreachable but keeps TS happy.
    throw lastErr instanceof Error ? lastErr : new Error('Unknown part-upload failure.');
  }

  /**
   * Single XHR PUT for one part. Wires per-part progress into `inFlightBytes`
   * and the throttled reporter.
   *
   * **DOES NOT set the `Content-Type` header** (execution-plan R3). For S3
   * the `UploadPart` presign doesn't cover Content-Type; sending it could
   * break SigV4 verification at intermediaries that forward the header
   * inconsistently. For local the route signs no Content-Type either. The
   * runtime auto-populates `Content-Length` from the Blob slice.
   *
   * ETag extraction: prefers the response header (the canonical S3 contract),
   * falls back to a JSON body field `{ etag }` for the local backend. Both
   * paths land in the same `etag` string. CORS note: S3 buckets MUST expose
   * the ETag header via `Access-Control-Expose-Headers`; without that, the
   * header read returns null cross-origin and the part is unusable.
   */
  function uploadPartOnce(url: string, blob: Blob, partNumber: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      // Intentionally NO Content-Type header — see JSDoc above.

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          inFlightBytes.set(partNumber, e.loaded);
          scheduleProgress();
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const headerEtag = xhr.getResponseHeader('ETag');
          const etag =
            headerEtag !== null && headerEtag.length > 0
              ? headerEtag
              : parseEtagFromJsonBody(xhr.responseText);
          if (etag === null) {
            // Permanent: no point retrying — the server WILL respond the same
            // way next attempt. Usually a CORS misconfiguration on S3.
            reject(new PartUploadError(xhr.status, 'Missing ETag in response.', false));
            return;
          }
          resolve(etag);
          return;
        }
        const retryable = xhr.status >= 500 || xhr.status === 408 || xhr.status === 429;
        reject(new PartUploadError(xhr.status, `Part upload failed (status=${xhr.status}).`, retryable));
      };

      xhr.onerror = () => {
        // Network-level failure — retryable.
        reject(new PartUploadError(0, `Network error during part upload (status=${xhr.status}).`, true));
      };

      xhr.onabort = () => {
        reject(new DOMException('Upload aborted', 'AbortError'));
      };

      if (internalAc.signal.aborted) {
        xhr.abort();
        return;
      }
      const onAbort = (): void => xhr.abort();
      internalAc.signal.addEventListener('abort', onAbort, { once: true });

      xhr.send(blob);
    });
  }

  // -------------------------------------------------------------------------
  // Drive workers; on any failure / abort, run the cleanup abort and return.
  // -------------------------------------------------------------------------
  let workerError: unknown = null;
  try {
    await Promise.all(workers);
  } catch (err) {
    workerError = err;
    // First error tears the rest via the shared AbortController.
    internalAc.abort();
  }

  // Always flush a final progress sample so the UI lands cleanly.
  if (progressTimer !== null) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  flushProgress();

  if (internalAc.signal.aborted || workerError !== null) {
    await runAbort(input.multipart, ticketId);
    cleanupExternalAbort();
    if (input.signal?.aborted) {
      return { kind: 'error', message: 'Upload cancelled.' };
    }
    return {
      kind: 'failed',
      reason: workerError !== null ? describeUploadError(workerError) : 'Upload aborted.',
    };
  }

  // -------------------------------------------------------------------------
  // completing → completed | failed
  // -------------------------------------------------------------------------
  // S3 requires the parts list sorted by partNumber; workers push in
  // completion order, so we sort here once before sending.
  completedParts.sort((a, b) => a.partNumber - b.partNumber);

  let completeOutcome: UploadFinalizeOutcome;
  try {
    completeOutcome = await input.multipart.complete(ticketId, completedParts);
  } catch (err) {
    await runAbort(input.multipart, ticketId);
    cleanupExternalAbort();
    return { kind: 'error', message: `Multipart complete failed: ${describeUploadError(err)}` };
  }

  // Flush one more time so 100% lands after the server-side finalize.
  if (input.onProgress) input.onProgress({ loaded: total, total });

  cleanupExternalAbort();
  return completeOutcome;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Marker error thrown by `uploadPartOnce`. The `retryable` flag lets the
 * retry loop decide without re-parsing the message — and crucially, lets it
 * STOP retrying on 4xx (signature failure, bad length, expired URL) so the
 * user sees a real error instead of a 7-second stall.
 */
class PartUploadError extends Error {
  public readonly status: number;
  public readonly retryable: boolean;
  public constructor(status: number, message: string, retryable: boolean) {
    super(message);
    this.name = 'PartUploadError';
    this.status = status;
    this.retryable = retryable;
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof PartUploadError) return err.retryable;
  // Anything else (network exception, generic Error) is treated as retryable —
  // the XHR onerror path always wraps in PartUploadError, so this branch
  // catches only truly unexpected exceptions which are almost always transient.
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  return true;
}

/**
 * Backoff for retry attempt `attempt` (0-based) with ±20% jitter. Reads from
 * `PART_RETRY_BACKOFF_MS`; falls back to the last entry if the attempt index
 * exceeds the table (defensive — the retry loop bound prevents this anyway).
 */
function getBackoffMs(attempt: number): number {
  const base =
    PART_RETRY_BACKOFF_MS[attempt] ??
    PART_RETRY_BACKOFF_MS[PART_RETRY_BACKOFF_MS.length - 1] ??
    1000;
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

/**
 * Sleep for `ms`, but bail out early if the signal aborts. Resolves (not
 * rejects) on abort so the caller's abort handling decides what to do — the
 * retry loop checks `signal.aborted` immediately after.
 */
function delayWithJitter(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Parse `{ etag: "..." }` from a JSON body. Used as the local-backend
 * fallback when the response header isn't readable (it should always be, but
 * the contract is "header preferred, body fallback").
 */
function parseEtagFromJsonBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { etag?: unknown };
    return typeof parsed.etag === 'string' && parsed.etag.length > 0 ? parsed.etag : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort server abort with a 5s ceiling. NEVER throws — the caller is
 * already in a failure / cancel path and the server-side TTL sweep is the
 * durable safety net for any orphaned session this call misses.
 */
async function runAbort(deps: MultipartDeps, ticketId: string): Promise<void> {
  try {
    await Promise.race([
      deps.abort(ticketId).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, ABORT_CALL_TIMEOUT_MS)),
    ]);
  } catch {
    // Swallow: the sweep cleans up.
  }
}

function describeUploadError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
