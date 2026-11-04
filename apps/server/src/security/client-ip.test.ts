import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import type { ClientIpSource, SecurityConfig } from '../config.js';
import { normalizeIp } from './client-ip.js';
import { createRateLimitMiddleware, FixedWindowRateLimiter } from './rate-limit.js';

function security(clientIpSource: ClientIpSource): SecurityConfig {
  const limit = { max: 100, windowSeconds: 300 };
  return {
    clientIpSource,
    trustProxyHeaders: clientIpSource.kind !== 'socket',
    rateLimit: {
      enabled: true,
      maxTrackedKeys: 100,
      auth: { max: 2, windowSeconds: 300 },
      setup: limit,
      publicLink: limit,
      publicUpload: limit,
      publicTicket: limit,
      publicPartUrls: limit,
      publicConfirm: limit,
    },
    headers: {
      enabled: false,
      hstsEnabled: false,
      hstsMaxAgeSeconds: 0,
      hstsIncludeSubDomains: false,
      hstsPreload: false,
      cspExtraConnectSrc: [],
    },
  };
}

/** Sends five sign-in-shaped requests through an `auth:<ip>` limiter and returns the statuses. */
async function statuses(
  source: ClientIpSource,
  headersFor: (n: number) => Record<string, string>,
): Promise<number[]> {
  const sec = security(source);
  const app = new Hono();
  app.use(
    '*',
    createRateLimitMiddleware(sec, new FixedWindowRateLimiter(100), (_c, ip) => [
      { key: `auth:${ip}`, limit: sec.rateLimit.auth },
    ]),
  );
  app.post('/sign-in', (c) => c.json({ ok: true }));

  const out: number[] = [];
  for (let n = 1; n <= 5; n++) {
    const res = await app.request('/sign-in', { method: 'POST', headers: headersFor(n) });
    out.push(res.status);
  }
  return out;
}

const THROTTLED = [200, 200, 429, 429, 429];

test('xff source takes the proxy-appended entry, not the client-supplied leftmost one', async () => {
  const result = await statuses({ kind: 'xff', trustedHops: 1 }, (n) => ({
    'x-forwarded-for': `10.0.0.${n}, 203.0.113.9`,
  }));
  assert.deepEqual(result, THROTTLED);
});

test('xff source ignores CF-Connecting-IP', async () => {
  const result = await statuses({ kind: 'xff', trustedHops: 1 }, (n) => ({
    'cf-connecting-ip': `198.51.100.${n}`,
    'x-forwarded-for': '203.0.113.9',
  }));
  assert.deepEqual(result, THROTTLED);
});

test('cf-connecting-ip source buckets each Cloudflare-set address separately', async () => {
  const result = await statuses({ kind: 'header', header: 'cf-connecting-ip' }, (n) => ({
    'cf-connecting-ip': `198.51.100.${n}`,
  }));
  assert.deepEqual(result, [200, 200, 200, 200, 200]);
});

test('socket source ignores every forwarding header', async () => {
  const result = await statuses({ kind: 'socket' }, (n) => ({
    'cf-connecting-ip': `198.51.100.${n}`,
    'x-real-ip': `192.0.2.${n}`,
    'x-forwarded-for': `10.0.0.${n}`,
  }));
  assert.deepEqual(result, THROTTLED);
});

test('normalizeIp canonicalizes mapped IPv4 and IPv6 /64s, leaves the rest alone', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(normalizeIp('2001:db8:1:2:aaaa::1'), normalizeIp('2001:0db8:0001:0002:ffff:1:2:3'));
  assert.notEqual(normalizeIp('2001:db8:1:2::1'), normalizeIp('2001:db8:1:3::1'));
  assert.equal(normalizeIp('1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp('garbage'), 'garbage');
});
