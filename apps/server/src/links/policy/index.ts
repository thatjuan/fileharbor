/**
 * Link policy: pure functions that decide whether a link is currently usable.
 *
 * Why this lives in its own module from day one, even though #5 only ever
 * returns `ok` or `disabled`: the result shape — a discriminated union of all
 * possible outcomes — is the contract every later slice (#6 password/quota/
 * expiry, #7 download, #8 send) builds against. Pin the shape early so adding
 * `password_required` in #6 is a single arm change, not a refactor.
 *
 * No I/O. The caller supplies the inputs (link row, "now", uploads-so-far,
 * supplied password). The function returns a verdict. Side effects (logging,
 * mutating counters) live elsewhere.
 */

import type { ReceiveLink } from '../receive-links.js';

export type ReceiveLinkPolicyResult =
  | { kind: 'ok' }
  | { kind: 'disabled' }
  | { kind: 'expired' }
  | { kind: 'quota_exhausted' }
  | { kind: 'password_required' }
  | { kind: 'password_wrong' };

/**
 * Decide whether `link` is currently usable for upload.
 *
 * - `now` is unix epoch seconds (UTC). Passed in (not read here) so callers
 *   can drive deterministic tests in later slices.
 * - `uploadsSoFar` is the count of `completed` files already attached to the
 *   link. Caller computes it (cheap join — see `receive-links.recordUploadCount`).
 * - `providedPassword` is the plaintext password the uploader supplied, if any.
 *   #5 ignores it (no link ever has a password); #6 lights up the comparison.
 *
 * For #5 only the `disabled` arm is reachable. The rest are stubbed so the
 * call sites are stable when #6 fills them in.
 */
export function evaluateReceiveLink(
  link: ReceiveLink,
  now: number,
  uploadsSoFar: number,
  providedPassword: string | null,
): ReceiveLinkPolicyResult {
  if (link.status === 'disabled') return { kind: 'disabled' };

  // The remaining checks are stubbed for #5 — every column they read is null
  // until #6 adds the form fields. They're written defensively so #6 only has
  // to flesh out the password comparison.

  if (link.expiresAt !== null && link.expiresAt <= now) {
    return { kind: 'expired' };
  }

  if (link.maxUploads !== null && uploadsSoFar >= link.maxUploads) {
    return { kind: 'quota_exhausted' };
  }

  if (link.passwordHash !== null) {
    if (providedPassword === null || providedPassword.length === 0) {
      return { kind: 'password_required' };
    }
    // #6 wires the real comparison. Intentionally pessimistic in the meantime:
    // if someone manages to set a password_hash before #6 lands, every upload
    // is rejected as `password_wrong` rather than silently accepted.
    return { kind: 'password_wrong' };
  }

  return { kind: 'ok' };
}
