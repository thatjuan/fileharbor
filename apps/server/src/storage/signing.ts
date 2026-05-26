import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 URL signing for the local storage backend.
 *
 * Mirrors the security property of an S3 SigV4 presigned URL: the signed
 * envelope binds the request method, key, expiry, and (when set) the
 * `Content-Type` / `Content-Length` the uploader promised to send. A client
 * that tries to deviate from those promises produces a signature that no
 * longer verifies, and the route returns 403. Possession of the URL is the
 * authorization; the verifier never trusts that the signer ran any check.
 *
 * `PUT-PART` signs the same envelope plus `uploadId` and `partNumber`;
 * combined with the distinct method literal, a part-PUT URL cannot be
 * replayed as a normal `PUT /put/<key>` (different `method` line → different
 * signature). The two trailing positional fields are empty strings for non-
 * `PUT-PART` methods.
 *
 * NOTE — backward incompatibility at deploy time: adding two trailing
 * positional lines to the canonical changes the signature of every method,
 * including in-flight single-PUT presigned URLs that were minted by a
 * previous server build. The default presign TTL is 5 minutes (see
 * `STORAGE_PRESIGN_TTL_SECONDS`), so the deploy gap is bounded to seconds-
 * to-minutes of stale single-PUT URLs that will fail with 403; recipients
 * retry and the next URL verifies cleanly. No persisted state is affected.
 */

export type CanonicalMethod = 'PUT' | 'GET' | 'DELETE' | 'PUT-PART';

export interface CanonicalParams {
  method: CanonicalMethod;
  /** Object key — the same opaque string the rest of the system uses. */
  key: string;
  /** Unix-seconds expiry. */
  exp: number;
  contentType?: string;
  contentLength?: number;
  /** Sets the response `Content-Disposition` on GET (friendly filename). */
  responseContentDisposition?: string;
  /** Multipart only: the upload session id. Empty/undefined for non-`PUT-PART` methods. */
  uploadId?: string;
  /** Multipart only: 1-based part number in `[1, 10000]`. */
  partNumber?: number;
}

const KEY_CLASS = /^[A-Za-z0-9._/-]+$/;

/**
 * Object-key validator. Run at sign time AND at verify time (defence in
 * depth — the verifier never trusts that the signer ran the same check).
 *
 * Rules:
 *   - Allowed chars: `[A-Za-z0-9._/-]`.
 *   - No leading slash.
 *   - No double slash (no empty segment).
 *   - No `.` or `..` segment.
 */
export function validateKey(key: string): boolean {
  if (!key || key.length === 0) return false;
  if (key.startsWith('/')) return false;
  if (!KEY_CLASS.test(key)) return false;
  const segments = key.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/**
 * Canonical string fed into HMAC. Empty optional fields appear as empty
 * lines to keep the structure positional and unambiguous.
 */
function canonical(p: CanonicalParams): string {
  return [
    p.method,
    p.key,
    String(p.exp),
    p.contentType ?? '',
    p.contentLength !== undefined ? String(p.contentLength) : '',
    p.responseContentDisposition ?? '',
    p.uploadId ?? '',
    p.partNumber !== undefined ? String(p.partNumber) : '',
  ].join('\n');
}

export function signCanonical(p: CanonicalParams, secret: string): string {
  return createHmac('sha256', secret).update(canonical(p)).digest('base64url');
}

/**
 * Constant-time signature check. A length mismatch short-circuits before
 * `timingSafeEqual` to avoid throwing on differing-length buffers.
 */
export function verifySignature(p: CanonicalParams, providedSig: string, secret: string): boolean {
  const expected = signCanonical(p, secret);
  if (providedSig.length !== expected.length) return false;
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
