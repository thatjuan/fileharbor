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

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  public constructor(private readonly maxTrackedKeys: number) {}

  public consume(key: string, limit: WindowLimitConfig, nowMs = Date.now()): RateLimitResult {
    this.pruneExpired(nowMs);

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
