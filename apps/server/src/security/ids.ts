/**
 * Shape checks for identifiers that arrive in public URL paths. Handlers run
 * them before touching a rate limiter, so junk path values never create keys.
 */

/** True when `s` is a UUID in canonical 8-4-4-4-12 form. Ticket IDs are `randomUUID()`. */
export const isUuid = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
