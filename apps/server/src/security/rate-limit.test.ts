import test from 'node:test';
import assert from 'node:assert/strict';

import { FixedWindowRateLimiter } from './rate-limit.js';

test('fixed-window limiter isolates keys and resets after the window', () => {
  const limiter = new FixedWindowRateLimiter(100);
  const limit = { max: 2, windowSeconds: 10 };

  assert.equal(limiter.consume('a', limit, 1_000).allowed, true);
  assert.equal(limiter.consume('a', limit, 2_000).allowed, true);
  const blocked = limiter.consume('a', limit, 3_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 8);

  assert.equal(limiter.consume('b', limit, 3_000).allowed, true);
  assert.equal(limiter.consume('a', limit, 11_001).allowed, true);
});

test('fixed-window limiter bounds tracked keys', () => {
  const limiter = new FixedWindowRateLimiter(2);
  const limit = { max: 10, windowSeconds: 60 };

  assert.equal(limiter.consume('a', limit, 1_000).allowed, true);
  assert.equal(limiter.consume('b', limit, 1_000).allowed, true);
  assert.equal(limiter.consume('c', limit, 1_000).allowed, true);

  assert.equal(limiter.size(), 2);
});

test('inspecting a limiter bucket does not consume capacity', () => {
  const limiter = new FixedWindowRateLimiter(100);
  const limit = { max: 2, windowSeconds: 10 };

  assert.equal(limiter.inspect('a', limit, 1_000).allowed, true);
  assert.equal(limiter.size(), 0);

  assert.equal(limiter.consume('a', limit, 1_000).allowed, true);
  assert.equal(limiter.inspect('a', limit, 2_000).allowed, true);
  assert.equal(limiter.consume('a', limit, 2_000).allowed, true);

  const blocked = limiter.inspect('a', limit, 3_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 8);
});

test('filling the public limiter cannot reset an exhausted auth bucket', () => {
  const limit = { max: 2, windowSeconds: 300 };
  const exhaust = (limiter: FixedWindowRateLimiter): void => {
    limiter.consume('auth:1.2.3.4', limit, 1_000);
    limiter.consume('auth:1.2.3.4', limit, 1_000);
  };
  const flood = (limiter: FixedWindowRateLimiter): void => {
    for (let i = 0; i < 50; i += 1) limiter.consume(`public-link:9.9.9.9:J${i}`, limit, 2_000);
  };

  // One shared map: junk keys evict the oldest bucket, restoring the budget.
  const shared = new FixedWindowRateLimiter(50);
  exhaust(shared);
  flood(shared);
  assert.equal(shared.consume('auth:1.2.3.4', limit, 3_000).allowed, true);

  const authLimiter = new FixedWindowRateLimiter(50);
  const publicLimiter = new FixedWindowRateLimiter(50);
  exhaust(authLimiter);
  flood(publicLimiter);
  assert.equal(authLimiter.consume('auth:1.2.3.4', limit, 3_000).allowed, false);
});

test('expired buckets are swept at most once per second but read as fresh', () => {
  const limiter = new FixedWindowRateLimiter(100);
  const limit = { max: 1, windowSeconds: 1 };

  limiter.consume('x', limit, 0); // sweep at 0
  limiter.consume('a', limit, 500); // exhausted until 1500
  limiter.consume('y', limit, 1_000); // sweep at 1000 drops `x`
  limiter.consume('z', limit, 1_600); // under a second since the sweep: none

  assert.equal(limiter.size(), 3); // `a` has expired but is still tracked
  assert.equal(limiter.inspect('a', limit, 1_600).allowed, true);

  limiter.consume('w', limit, 2_000); // sweep drops `a` and `y`
  assert.equal(limiter.size(), 2);
});
