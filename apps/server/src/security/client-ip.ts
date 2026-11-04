import { isIPv6 } from 'node:net';

import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

import type { SecurityConfig } from '../config.js';

/**
 * The client address used for rate-limit keys. Reads exactly one source, chosen at
 * boot (see ClientIpSource), so a header the deployed proxy does not control can
 * never pick the bucket. Falls back to the socket peer when that source is absent.
 */
export function clientIpFor(c: Context, security: SecurityConfig): string {
  const src = security.clientIpSource;
  switch (src.kind) {
    case 'header': {
      const v = c.req.header(src.header)?.trim();
      if (v) return normalizeIp(v);
      break;
    }
    case 'xff': {
      const parts = (c.req.header('x-forwarded-for') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const v = parts[parts.length - src.trustedHops];
      if (v) return normalizeIp(v);
      break;
    }
    case 'socket':
      break;
    default: {
      const exhaustive: never = src;
      return exhaustive;
    }
  }
  return normalizeIp(socketAddress(c));
}

/** The TCP peer address, or `'unknown'` when the runtime cannot report one. */
function socketAddress(c: Context): string {
  try {
    const remote = getConnInfo(c).remote.address;
    return remote && remote.length > 0 ? remote : 'unknown';
  } catch {
    return 'unknown';
  }
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Canonical bucket identity for an address: IPv4-mapped IPv6 becomes plain IPv4,
 * and IPv6 collapses to its /64 (one subscriber typically holds a whole /64, so
 * per-address buckets would be free to rotate). Anything unparseable is returned
 * unchanged.
 */
export function normalizeIp(ip: string): string {
  const mapped = IPV4_MAPPED.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(ip)) return ip;

  const groups = expandIpv6(ip);
  if (!groups) return ip;
  const prefix = groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':');
  return `${prefix}::/64`;
}

/** Expand a valid IPv6 literal into its eight 16-bit groups (zone id dropped). */
function expandIpv6(ip: string): number[] | null {
  let addr = ip.split('%')[0] ?? ip;

  // An embedded dotted IPv4 tail (e.g. `64:ff9b::1.2.3.4`) is two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
    addr = `${addr.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head = '', tail] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}
