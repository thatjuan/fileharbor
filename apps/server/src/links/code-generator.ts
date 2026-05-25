import { randomInt } from 'node:crypto';

/**
 * URL-code generator for receive/send links.
 *
 * Alphabet: Crockford base32 — `0-9` and `A-Z` minus `I L O U`. Picked because:
 *   - 32 chars: each code character is exactly 5 bits, so length × 5 = entropy.
 *   - Ambiguity-stripped: `I/1/L`, `O/0`, and `U` are absent.
 *   - URL-safe with no escaping or case juggling at the protocol level.
 *
 * Default length is 8: 5 × 8 = 40 bits = ~10^12. Collision probability at any
 * realistic scale (millions of links) is vanishingly small; the DB unique
 * constraint plus the retry loop in `mintUniqueCode` are belt-and-braces.
 *
 * The codes are case-insensitive at the link-policy layer (lookup lowercases
 * the input). Codes are minted in uppercase for readability when written down.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const DEFAULT_CODE_LENGTH = 8;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Generate a single random code of `length` characters from the Crockford
 * base32 alphabet. Each character is drawn with a uniform CSPRNG-backed pick
 * (`crypto.randomInt`) — 32 is a power of two and divides 2^32 cleanly, so the
 * standard `randomInt(0, 32)` is unbiased.
 */
export function generateCode(length: number = DEFAULT_CODE_LENGTH): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`Invalid code length: ${length}`);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

/**
 * Asks the caller "does this code exist?" and retries on collision. Pure-ish:
 * the only I/O is the probe the caller wires in. Defaults match `generateCode`.
 *
 * Throws after `maxAttempts` consecutive collisions. The 40-bit space makes
 * that practically impossible; if it does happen, something has gone very
 * wrong (RNG seed reuse, mass-import of pre-existing codes) and surfacing the
 * failure is correct.
 */
export async function mintUniqueCode(
  exists: (code: string) => Promise<boolean>,
  opts?: { length?: number; maxAttempts?: number },
): Promise<string> {
  const length = opts?.length ?? DEFAULT_CODE_LENGTH;
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = generateCode(length);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(
    `code-generator: ${maxAttempts} consecutive collisions at length=${length}. ` +
      `Either the alphabet space is exhausted or the probe function is misbehaving.`,
  );
}

/**
 * Normalise a code as received from a URL into the canonical form used in the
 * DB. Crockford convention: lowercase the input, then map any aliases —
 * `O→0`, `I/L→1` — back into the alphabet. We accept aliases on lookup so a
 * user who typo'd `O` for `0` still resolves. We never *mint* aliased codes.
 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}
