/**
 * Multipart upload configuration sourced from the server at runtime.
 *
 * The server is the source of truth for these knobs (set via the
 * `STORAGE_MULTIPART_*` env vars). The frontend never hard-codes them in
 * production logic — operators can tune the threshold or part size by
 * restarting the server, without rebuilding the bundle.
 *
 * One module-scope lazy-memoized promise dedupes parallel callers (page
 * mount, upload start). On fetch/parse failure, we fall back to sane
 * defaults and log a warning so the page stays usable.
 */

export interface UploadConfig {
  multipartThresholdBytes: number;
  multipartPartSizeBytes: number;
  multipartTtlSeconds: number;
  maxObjectSizeBytes: number;
}

/**
 * Fallback values used when `/api/config/upload` is unreachable or returns a
 * malformed payload. Chosen to match the server's documented defaults so a
 * silent fallback behaves like a correctly-configured stock deployment.
 */
export const DEFAULT_UPLOAD_CONFIG: UploadConfig = {
  multipartThresholdBytes: 100 * 1024 * 1024,
  multipartPartSizeBytes: 16 * 1024 * 1024,
  multipartTtlSeconds: 7200,
  maxObjectSizeBytes: 50 * 1024 ** 3, // 50 GiB — conservative default; backend may report higher.
};

const WARN_PREFIX = '[upload-config] failed to fetch /api/config/upload, falling back to defaults:';

let cached: Promise<UploadConfig> | null = null;

/**
 * Returns the shared upload-config promise. First caller triggers the fetch;
 * subsequent callers (including parallel ones) get the same in-flight or
 * resolved promise. The returned promise NEVER rejects — on any failure we
 * resolve with `DEFAULT_UPLOAD_CONFIG` and log a warning, because the
 * single-PUT path must remain usable for small files even when this endpoint
 * is broken.
 */
export function getUploadConfig(): Promise<UploadConfig> {
  if (cached !== null) return cached;
  cached = fetchUploadConfig();
  return cached;
}

/**
 * @internal — test-only.
 */
export function resetUploadConfigCache(): void {
  cached = null;
}

async function fetchUploadConfig(): Promise<UploadConfig> {
  let response: Response;
  try {
    response = await fetch('/api/config/upload');
  } catch (err) {
    console.warn(`${WARN_PREFIX} ${describeError(err)}`);
    return DEFAULT_UPLOAD_CONFIG;
  }

  if (!response.ok) {
    console.warn(`${WARN_PREFIX} HTTP ${response.status}`);
    return DEFAULT_UPLOAD_CONFIG;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    console.warn(`${WARN_PREFIX} invalid JSON (${describeError(err)})`);
    return DEFAULT_UPLOAD_CONFIG;
  }

  const parsed = parseUploadConfig(body);
  if (parsed === null) {
    console.warn(`${WARN_PREFIX} response missing or invalid fields`);
    return DEFAULT_UPLOAD_CONFIG;
  }

  return parsed;
}

function parseUploadConfig(body: unknown): UploadConfig | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;

  const threshold = toPositiveInteger(record.multipartThresholdBytes);
  const partSize = toPositiveInteger(record.multipartPartSizeBytes);
  const ttl = toPositiveInteger(record.multipartTtlSeconds);
  const maxObject = toPositiveInteger(record.maxObjectSizeBytes);

  // Wholesale fall-back: a partial payload is treated as a misconfigured
  // server, not a partial victory. Easier to reason about and surfaces the
  // operator error via the warn log rather than silently mixing values.
  if (threshold === null || partSize === null || ttl === null || maxObject === null) {
    return null;
  }

  return {
    multipartThresholdBytes: threshold,
    multipartPartSizeBytes: partSize,
    multipartTtlSeconds: ttl,
    maxObjectSizeBytes: maxObject,
  };
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value <= 0) return null;
  return value;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
