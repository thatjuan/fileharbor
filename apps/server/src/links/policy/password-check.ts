import { verifyPassword } from '@better-auth/utils/password';

import type { PasswordCheck } from './index.js';

/**
 * Resolve the password verdict for a link (either intent — both have the same
 * shape of `passwordHash` field). Async because scrypt is async; running it
 * here lets the policy modules stay pure synchronous functions.
 *
 * `verifyPassword` is constant-time on the hash bytes; passing a non-matching
 * plaintext yields `false` without a timing channel that distinguishes "no
 * hash on file" from "wrong password" — the `null` short-circuit handles the
 * former case before we get here.
 *
 * Lifted from `upload-tickets.ts` / `download-tickets.ts` in #11 — once both
 * ticket lifecycles depend on the same primitive, the verbatim duplication
 * starts paying interest. One source, two callers.
 */
export async function resolvePasswordCheck(
  passwordHash: string | null,
  providedPassword: string | null,
): Promise<PasswordCheck> {
  if (passwordHash === null) return { kind: 'not_required' };
  if (providedPassword === null || providedPassword.length === 0) {
    return { kind: 'missing' };
  }
  const ok = await verifyPassword(passwordHash, providedPassword);
  return ok ? { kind: 'correct' } : { kind: 'wrong' };
}
