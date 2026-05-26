import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';
import type { SecurityConfig } from '../config.js';
import { createAdminOriginGuard } from './origin.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { createSetupRoute } from '../routes/setup.js';
import { createPublicUploadTicketsRoute } from '../routes/public-upload-tickets.js';
import type { UploadTicketsModule } from '../tickets/upload-tickets.js';

function security(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  const base: SecurityConfig = {
    trustProxyHeaders: false,
    rateLimit: {
      enabled: true,
      maxTrackedKeys: 100,
      auth: { max: 10, windowSeconds: 300 },
      setup: { max: 1, windowSeconds: 900 },
      publicLink: { max: 10, windowSeconds: 300 },
      publicTicket: { max: 10, windowSeconds: 60 },
      publicPartUrls: { max: 10, windowSeconds: 60 },
      publicConfirm: { max: 10, windowSeconds: 60 },
    },
    headers: {
      enabled: false,
      hstsEnabled: false,
      hstsMaxAgeSeconds: 15552000,
      hstsIncludeSubDomains: false,
      hstsPreload: false,
      cspExtraConnectSrc: [],
    },
  };
  return { ...base, ...overrides };
}

test('setup POST rate-limits by client IP with stable JSON', async () => {
  const authModule = {
    auth: {},
    hasAnyUser: () => false,
    getSession: async () => null,
    createAdmin: async () => {},
  } as unknown as AuthModule;
  const route = createSetupRoute(authModule, security(), new FixedWindowRateLimiter(100));
  const app = new Hono().route('/setup', route);
  const body = JSON.stringify({ username: 'admin', password: 'password123' });

  const first = await app.request('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(first.status, 200);

  const second = await app.request('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), {
    error: 'rate_limited',
    message: 'Too many requests. Try again later.',
  });
});

test('public multipart part URLs use body password and reject query password', async () => {
  let capturedPassword: string | null | undefined;
  const module = {
    async getMultipartPartUrls(_ticketId, _from, _to, providedPassword) {
      capturedPassword = providedPassword;
      return {
        kind: 'ok',
        value: {
          urls: [{ partNumber: 1, url: 'https://storage.example/part' }],
          expiresAt: new Date(0).toISOString(),
        },
      };
    },
  } as UploadTicketsModule;

  const route = createPublicUploadTicketsRoute(module, security(), new FixedWindowRateLimiter(100));
  const app = new Hono().route('/upload-tickets', route);

  const post = await app.request('/upload-tickets/t1/upload/multipart/parts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 1, to: 1, password: 'secret-pass' }),
  });
  assert.equal(post.status, 200);
  assert.equal(capturedPassword, 'secret-pass');

  const get = await app.request(
    '/upload-tickets/t1/upload/multipart/parts?from=1&to=1&password=secret-pass',
  );
  assert.equal(get.status, 400);
  assert.deepEqual(await get.json(), { error: 'password_in_query_not_allowed' });
});

test('admin origin guard accepts configured origin and rejects cross-origin mutation', async () => {
  const config = {
    nodeEnv: 'production',
    auth: { baseUrl: 'https://files.example.com' },
  } as Parameters<typeof createAdminOriginGuard>[0];
  const app = new Hono();
  app.use('/admin', createAdminOriginGuard(config));
  app.post('/admin', (c) => c.json({ ok: true }));

  const sameOrigin = await app.request('/admin', {
    method: 'POST',
    headers: { origin: 'https://files.example.com' },
  });
  assert.equal(sameOrigin.status, 200);

  const crossOrigin = await app.request('/admin', {
    method: 'POST',
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { error: 'forbidden' });
});
