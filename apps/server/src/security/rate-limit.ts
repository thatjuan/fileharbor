import type { Context, MiddlewareHandler } from 'hono';

import type { SecurityConfig, WindowLimitConfig } from '../config.js';
import { clientIpFor } from './client-ip.js';

interface Bucket {
  count: number;
  resetAtMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Minimum gap between full sweeps of expired buckets in `consume`. */
const PRUNE_INTERVAL_MS = 1000;

/**
 * In-memory fixed-window limiter. A bucket whose window has ended counts as
 * absent; expired buckets are swept at most once per second, so a request
 * costs O(1) amortized however many keys are tracked. At `maxTrackedKeys` the
 * oldest-inserted keys are evicted, so callers keep high-volume anonymous
 * traffic and brute-force buckets in separate instances (see `app.ts`).
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastPruneMs = Number.NEGATIVE_INFINITY;

  public constructor(private readonly maxTrackedKeys: number) {}

  /** Counts one hit against `key`, creating its bucket when absent or expired. */
  public consume(key: string, limit: WindowLimitConfig, nowMs = Date.now()): RateLimitResult {
    if (nowMs - this.lastPruneMs >= PRUNE_INTERVAL_MS) {
      this.pruneExpired(nowMs);
      this.lastPruneMs = nowMs;
    }

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAtMs <= nowMs) {
      this.evictIfNeeded(nowMs);
      this.buckets.set(key, {
        count: 1,
        resetAtMs: nowMs + limit.windowSeconds * 1000,
      });
      return { allowed: true, retryAfterSeconds: limit.windowSeconds };
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
    if (existing.count >= limit.max) {
      return { allowed: false, retryAfterSeconds };
    }

    existing.count += 1;
    return { allowed: true, retryAfterSeconds };
  }

  /** Checks a bucket without consuming capacity or creating a new bucket. */
  public inspect(key: string, limit: WindowLimitConfig, nowMs = Date.now()): RateLimitResult {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAtMs <= nowMs) {
      return { allowed: true, retryAfterSeconds: limit.windowSeconds };
    }

    return {
      allowed: existing.count < limit.max,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
    };
  }

  /** Number of tracked buckets, expired ones included until the next sweep. */
  public size(): number {
    return this.buckets.size;
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs <= nowMs) this.buckets.delete(key);
    }
  }

  private evictIfNeeded(nowMs: number): void {
    if (this.buckets.size < this.maxTrackedKeys) return;
    this.pruneExpired(nowMs);
    while (this.buckets.size >= this.maxTrackedKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.buckets.delete(oldest);
    }
  }
}

/**
 * The two limiter instances `createApp` builds. `auth` holds brute-force and
 * setup buckets; `public` holds the high-volume anonymous buckets, whose
 * eviction must never reset a brute-force bucket.
 */
export interface RateLimiters {
  auth: FixedWindowRateLimiter;
  public: FixedWindowRateLimiter;
}

export const rateLimitedBody = {
  error: 'rate_limited',
  message: 'Too many requests. Try again later.',
} as const;

export interface RateLimitCheck {
  key: string;
  limit: WindowLimitConfig;
}

export type RateLimitKeyBuilder = (c: Context, ip: string) => RateLimitCheck[];

export function createRateLimitMiddleware(
  security: SecurityConfig,
  limiter: FixedWindowRateLimiter,
  buildChecks: RateLimitKeyBuilder,
): MiddlewareHandler {
  return async (c, next) => {
    if (!security.rateLimit.enabled) {
      await next();
      return;
    }

    const ip = clientIpFor(c, security);
    const checks = buildChecks(c, ip);
    for (const check of checks) {
      const result = limiter.consume(check.key, check.limit);
      if (!result.allowed) {
        c.header('Retry-After', String(result.retryAfterSeconds));
        return c.json(rateLimitedBody, 429);
      }
    }

    await next();
  };
}

/**
 * Consumes each check in turn and answers 429 at the first denial.
 *
 * Order matters: checks run in order and stop at the first denial. Put the
 * per-IP aggregate first so a denied request cannot create per-target keys.
 */
export function enforceRateLimit(
  c: Context,
  security: SecurityConfig,
  limiter: FixedWindowRateLimiter,
  checks: RateLimitCheck[],
): Response | null {
  if (!security.rateLimit.enabled) return null;

  for (const check of checks) {
    const result = limiter.consume(check.key, check.limit);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json(rateLimitedBody, 429);
    }
  }
  return null;
}

/** Rejects a request only when a previously consumed bucket is already full. */
export function rejectIfRateLimitReached(
  c: Context,
  security: SecurityConfig,
  limiter: FixedWindowRateLimiter,
  checks: RateLimitCheck[],
): Response | null {
  if (!security.rateLimit.enabled) return null;

  for (const check of checks) {
    const result = limiter.inspect(check.key, check.limit);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json(rateLimitedBody, 429);
    }
  }
  return null;
}
