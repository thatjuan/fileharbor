import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

import type { SecurityConfig } from '../config.js';

function firstForwardedFor(raw: string | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export function clientIpFor(c: Context, security: SecurityConfig): string {
  if (security.trustProxyHeaders) {
    const cf = c.req.header('cf-connecting-ip')?.trim();
    if (cf) return cf;
    const real = c.req.header('x-real-ip')?.trim();
    if (real) return real;
    const forwarded = firstForwardedFor(c.req.header('x-forwarded-for'));
    if (forwarded) return forwarded;
  }

  try {
    const remote = getConnInfo(c).remote.address;
    return remote && remote.length > 0 ? remote : 'unknown';
  } catch {
    return 'unknown';
  }
}
