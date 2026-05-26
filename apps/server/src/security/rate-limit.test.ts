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
