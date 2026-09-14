import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AuthModule } from '../auth/index.js';
import { createAuthModule } from '../auth/index.js';
import type { AppConfig, SecurityConfig } from '../config.js';
import { openDatabase } from '../db/client.js';
import { createAdminOriginGuard } from './origin.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { createSetupRoute } from '../routes/setup.js';
import { createPublicReceiveLinksRoute } from '../routes/public-receive-links.js';
import { createPublicUploadTicketsRoute } from '../routes/public-upload-tickets.js';
import type { ReceiveLinksModule } from '../links/receive-links.js';
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
      publicUpload: { max: 1_000, windowSeconds: 300 },
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

test('public receive links admit hundreds of successful upload tickets', async () => {
  let created = 0;
  const uploadTicketsModule = {
    async createForReceiveLink() {
      created += 1;
      return {
        kind: 'ok',
        value: {
          ticketId: `ticket-${created}`,
          presignedPutUrl: 'https://storage.example/upload',
          expiresAt: new Date(0),
        },
      };
    },
  } as unknown as UploadTicketsModule;
  const route = createPublicReceiveLinksRoute(
    {} as ReceiveLinksModule,
    uploadTicketsModule,
    security(),
    new FixedWindowRateLimiter(2_000),
  );
  const app = new Hono().route('/receive-links', route);

  for (let index = 0; index < 500; index += 1) {
    const response = await app.request('/receive-links/BULK/upload-tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: `${index}.txt`,
        contentType: 'text/plain',
        size: 1,
      }),
    });
    assert.equal(response.status, 200);
  }
  assert.equal(created, 500);
});

test('public receive links retain a bounded bulk-upload limit', async () => {
  let created = 0;
  const uploadTicketsModule = {
    async createForReceiveLink() {
      created += 1;
      return {
        kind: 'ok',
        value: {
          ticketId: `ticket-${created}`,
          presignedPutUrl: 'https://storage.example/upload',
          expiresAt: new Date(0),
        },
      };
    },
  } as unknown as UploadTicketsModule;
  const config = security();
  config.rateLimit.publicUpload = { max: 2, windowSeconds: 300 };
  const route = createPublicReceiveLinksRoute(
    {} as ReceiveLinksModule,
    uploadTicketsModule,
    config,
    new FixedWindowRateLimiter(100),
  );
  const app = new Hono().route('/receive-links', route);
  const request = async (): Promise<Response> =>
    await app.request('/receive-links/BULK/upload-tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'file.txt', contentType: 'text/plain', size: 1 }),
    });

  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 429);
  assert.equal(created, 2);
});

test('successful uploads do not consume the password-failure limit', async () => {
  let attempts = 0;
  const uploadTicketsModule = {
    async createForReceiveLink(input: Parameters<UploadTicketsModule['createForReceiveLink']>[0]) {
      attempts += 1;
      if (input.providedPassword === 'correct') {
        return {
          kind: 'ok',
          value: {
            ticketId: `ticket-${attempts}`,
            presignedPutUrl: 'https://storage.example/upload',
            expiresAt: new Date(0),
          },
        };
      }
      return { kind: 'policy_rejected', policy: { kind: 'password_wrong' } };
    },
  } as unknown as UploadTicketsModule;
  const config = security();
  config.rateLimit.publicLink = { max: 2, windowSeconds: 300 };
  const route = createPublicReceiveLinksRoute(
    {} as ReceiveLinksModule,
    uploadTicketsModule,
    config,
    new FixedWindowRateLimiter(100),
  );
  const app = new Hono().route('/receive-links', route);
  const request = async (password: string): Promise<Response> =>
    await app.request('/receive-links/LOCKED/upload-tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'file.txt',
        contentType: 'text/plain',
        size: 1,
        password,
      }),
    });

  assert.equal((await request('correct')).status, 200);
  assert.equal((await request('correct')).status, 200);
  assert.equal((await request('wrong')).status, 403);
  assert.equal((await request('wrong')).status, 403);
  assert.equal((await request('wrong')).status, 429);
  assert.equal(attempts, 4);
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
  const config = originGuardConfig({
    baseUrl: 'https://other.example.com',
    trustProxyHeaders: false,
  });
  const app = new Hono();
  app.use('/admin', createAdminOriginGuard(config));
  app.delete('/admin', (c) => c.json({ ok: true }));

  const sameHost = await app.request('/admin', {
    method: 'DELETE',
    headers: { origin: 'https://files.example.com', host: 'files.example.com' },
  });
  assert.equal(sameHost.status, 200);
});

// --- Better Auth origin handling (/api/auth/*) --------------------------------
//
// `/api/auth/*` bypasses `createAdminOriginGuard` entirely — it goes straight
// to Better Auth's fetch handler, which runs its own CSRF/origin check against
// `trustedOrigins`. These cases pin that second boundary (#67).
//
// A 403 means Better Auth rejected the origin. Any other status means the
// origin was accepted and the request reached the endpoint; we don't sign in
// first, so a trusted sign-out just reports "no session".

function authConfig(overrides: { baseUrl?: string; trustProxyHeaders?: boolean } = {}): AppConfig {
  return {
    nodeEnv: 'production',
    auth: {
      baseUrl: overrides.baseUrl ?? 'http://localhost:3000',
      secret: 'test-secret-value-that-is-long-enough-1234',
      adminSeed: null,
    },
    security: security({ trustProxyHeaders: overrides.trustProxyHeaders ?? false }),
  } as unknown as AppConfig;
}

function authApp(config: AppConfig): Hono {
  const db = openDatabase(
    ':memory:',
    resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle'),
  );
  const authModule = createAuthModule(db, config);
  return new Hono().all('/api/auth/*', (c) => authModule.auth.handler(c.req.raw));
}

test('email-address usernames can sign in after setup', async () => {
  const db = openDatabase(
    ':memory:',
    resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle'),
  );
  const authModule = createAuthModule(db, authConfig());
  const app = new Hono()
    .route('/setup', createSetupRoute(authModule, security(), new FixedWindowRateLimiter(100)))
    .all('/api/auth/*', (c) => authModule.auth.handler(c.req.raw));

  const setup = await app.request('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'password123' }),
  });
  assert.equal(setup.status, 200);

  const signIn = await app.request('/api/auth/sign-in/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin@example.com', password: 'password123' }),
  });
  assert.equal(signIn.status, 200);
});

test('auth sign-out accepts the proxied public host when proxy headers are trusted', async () => {
  // The reported bug: BETTER_AUTH_URL resolves to the internal origin while the
  // browser posts from the tunnel's public host.
  const app = authApp(authConfig({ baseUrl: 'http://localhost:3000', trustProxyHeaders: true }));

  const res = await app.request('/api/auth/sign-out', {
    method: 'POST',
    headers: {
      origin: 'https://files.juan.ca',
      'x-forwarded-host': 'files.juan.ca',
      'x-forwarded-proto': 'https',
      host: 'localhost:3000',
      cookie: 'better-auth.session_token=not-a-real-session',
    },
  });
  assert.notEqual(res.status, 403);
});

test('auth sign-out accepts the Host header origin without a proxy', async () => {
  const app = authApp(authConfig({ baseUrl: 'https://other.example.com' }));

  const res = await app.request('/api/auth/sign-out', {
    method: 'POST',
    headers: {
      origin: 'https://files.example.com',
      host: 'files.example.com',
      cookie: 'better-auth.session_token=not-a-real-session',
    },
  });
  assert.notEqual(res.status, 403);
});

test('auth sign-out still rejects a genuinely cross-site origin', async () => {
  const app = authApp(authConfig({ baseUrl: 'http://localhost:3000', trustProxyHeaders: true }));

  const res = await app.request('/api/auth/sign-out', {
    method: 'POST',
    headers: {
      origin: 'https://evil.example.com',
      'x-forwarded-host': 'files.juan.ca',
      host: 'localhost:3000',
      cookie: 'better-auth.session_token=not-a-real-session',
    },
  });
  assert.equal(res.status, 403);
});
