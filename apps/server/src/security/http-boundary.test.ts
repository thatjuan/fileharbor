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

function originGuardConfig(
  overrides: { baseUrl?: string; nodeEnv?: string; trustProxyHeaders?: boolean } = {},
): Parameters<typeof createAdminOriginGuard>[0] {
  return {
    nodeEnv: overrides.nodeEnv ?? 'production',
    auth: { baseUrl: overrides.baseUrl ?? 'https://files.example.com' },
    security: security({ trustProxyHeaders: overrides.trustProxyHeaders ?? false }),
  } as Parameters<typeof createAdminOriginGuard>[0];
}

test('admin origin guard accepts configured origin and rejects cross-origin mutation', async () => {
  const app = new Hono();
  app.use('/admin', createAdminOriginGuard(originGuardConfig()));
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

test('admin origin guard accepts same-origin via X-Forwarded-Host when proxy trusted', async () => {
  // baseUrl differs from the public host (the misconfigured-tunnel case that
  // produced the 403 on DELETE). With trusted proxy headers, a request whose
  // Origin matches the forwarded host is allowed even though it isn't in the
  // configured allowlist.
  const config = originGuardConfig({ baseUrl: 'http://localhost:3000', trustProxyHeaders: true });
  const app = new Hono();
  app.use('/admin', createAdminOriginGuard(config));
  app.delete('/admin', (c) => c.json({ ok: true }));

  const proxied = await app.request('/admin', {
    method: 'DELETE',
    headers: {
      origin: 'https://files-dev.juan.ca',
      'x-forwarded-host': 'files-dev.juan.ca',
      'x-forwarded-proto': 'https',
      host: 'localhost:3000',
    },
  });
  assert.equal(proxied.status, 200);
});

test('admin origin guard ignores X-Forwarded-Host when proxy headers untrusted', async () => {
  // trustProxyHeaders=false: forwarded headers are attacker-spoofable, so they
  // must not widen the allowlist. Host (localhost:3000) is the only same-origin
  // signal, and it doesn't match the cross-origin Origin → rejected.
  const config = originGuardConfig({ baseUrl: 'http://localhost:3000', trustProxyHeaders: false });
  const app = new Hono();
  app.use('/admin', createAdminOriginGuard(config));
  app.delete('/admin', (c) => c.json({ ok: true }));

  const spoofed = await app.request('/admin', {
    method: 'DELETE',
    headers: {
      origin: 'https://files-dev.juan.ca',
      'x-forwarded-host': 'files-dev.juan.ca',
      host: 'localhost:3000',
    },
  });
  assert.equal(spoofed.status, 403);
});

test('admin origin guard accepts same-origin via Host header without proxy', async () => {
  // Direct exposure (no proxy): the browser's Origin matches the Host it
  // connected to. Host is browser-controlled-as-forbidden, so this is a sound
  // same-origin check even with trustProxyHeaders=false.
  const config = originGuardConfig({ baseUrl: 'https://other.example.com', trustProxyHeaders: false });
  const app = new Hono();
  app.use('/admin', createAdminOriginGuard(config));
  app.delete('/admin', (c) => c.json({ ok: true }));

  const sameHost = await app.request('/admin', {
    method: 'DELETE',
    headers: { origin: 'https://files.example.com', host: 'files.example.com' },
  });
  assert.equal(sameHost.status, 200);
});
