/**
 * Link policy: pure functions that decide whether a link is currently usable.
 *
 * No I/O. The caller supplies the inputs (link row, "now", uploads-so-far,
 * password verdict). The function returns a verdict. Side effects (logging,
 * mutating counters, hashing/verifying passwords) live elsewhere.
 *
 * Why the caller pre-resolves the password verdict (rather than passing in the
 * plaintext): password verification is async (scrypt). Keeping the policy a
 * pure synchronous function means every caller doesn't have to be `async`,
 * the function is trivial to reason about, and the policy module never sees
 * the plaintext or the hash. The caller's responsibility:
 *
 *   - If the link has no password (`passwordHash === null`): pass
 *     `{ kind: 'not_required' }`.
 *   - If the link has a password and the uploader supplied none (or empty):
 *     pass `{ kind: 'missing' }`.
 *   - If the link has a password and the uploader supplied one: verify it
 *     (await `verifyPassword`) and pass `{ kind: 'correct' }` or
 *     `{ kind: 'wrong' }`.
 */

import type { ReceiveLink } from '../receive-links.js';
import type { SendLink } from '../send-links.js';

export type ReceiveLinkPolicyResult =
  | { kind: 'ok' }
  | { kind: 'disabled' }
  | { kind: 'expired' }
  | { kind: 'quota_exhausted' }
  | { kind: 'password_required' }
  | { kind: 'password_wrong' };

/**
 * Result of evaluating a send link. Same discriminated shape as the receive
 * side — every branch maps 1:1 except for `quota_exhausted`, which on the
 * send side means `download_count >= max_downloads` rather than
 * `uploads_so_far >= max_uploads`. Reusing the shape lets the public surface
 * funnel both directions through one error code.
 */
export type SendLinkPolicyResult = ReceiveLinkPolicyResult;

/**
 * The caller's pre-resolved verdict on the password the uploader supplied.
 * See module docstring for the contract.
 */
export type PasswordCheck =
  | { kind: 'not_required' }
  | { kind: 'missing' }
  | { kind: 'correct' }
  | { kind: 'wrong' };

/**
 * Decide whether `link` is currently usable for upload.
 *
 * - `now` is unix epoch seconds (UTC). Passed in (not read here) so callers
 *   can drive deterministic tests.
 * - `uploadsSoFar` is the count of `completed` files already attached to the
 *   link.
 * - `passwordCheck` is the caller's resolved verdict on the supplied password.
 *
 * Evaluation order is intentional: `disabled` first (cheapest, hardest fail),
 * then time-based (`expired`), then quota, then password. The order doesn't
 * change which result wins for any given input — only one branch can be true
 * at a time for a well-formed call — but it keeps the read order easy to
 * follow.
 */
export function evaluateReceiveLink(
  link: ReceiveLink,
  now: number,
  uploadsSoFar: number,
  passwordCheck: PasswordCheck,
): ReceiveLinkPolicyResult {
  if (link.status === 'disabled') return { kind: 'disabled' };

  if (link.expiresAt !== null && link.expiresAt <= now) {
    return { kind: 'expired' };
  }

  if (link.maxUploads !== null && uploadsSoFar >= link.maxUploads) {
    return { kind: 'quota_exhausted' };
  }

  switch (passwordCheck.kind) {
    case 'not_required':
    case 'correct':
      return { kind: 'ok' };
    case 'missing':
      return { kind: 'password_required' };
    case 'wrong':
      return { kind: 'password_wrong' };
  }
}

/**
 * Decide whether `link` is currently usable for download.
 *
 * - `now` is unix epoch seconds (UTC). Caller-supplied for determinism.
 * - `downloadsSoFar` is the persisted `download_count` on the link row. In
 *   this slice (#8) it's always 0; #11 wires the decrement and the quota
 *   compare uses this value.
 * - `passwordCheck` is the caller's resolved verdict; identical contract to
 *   the receive side.
 *
 * Same evaluation order as the receive side: disabled → expired → quota →
 * password. The `quota_exhausted` branch fires when `downloadsSoFar` has
 * reached `maxDownloads` — semantic mirror of "uploads vs. max_uploads".
 */
export function evaluateSendLink(
  link: SendLink,
  now: number,
  downloadsSoFar: number,
  passwordCheck: PasswordCheck,
): SendLinkPolicyResult {
  if (link.status === 'disabled') return { kind: 'disabled' };

  if (link.expiresAt !== null && link.expiresAt <= now) {
    return { kind: 'expired' };
  }

  if (link.maxDownloads !== null && downloadsSoFar >= link.maxDownloads) {
    return { kind: 'quota_exhausted' };
  }

  switch (passwordCheck.kind) {
    case 'not_required':
    case 'correct':
      return { kind: 'ok' };
    case 'missing':
      return { kind: 'password_required' };
    case 'wrong':
      return { kind: 'password_wrong' };
  }
}
