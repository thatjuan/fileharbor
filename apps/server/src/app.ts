import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { AuthModule } from './auth/index.js';
import type { AppConfig } from './config.js';
import type { FilesModule } from './files/files.js';
import type { ReceiveLinksModule } from './links/receive-links.js';
import type { SendLinksModule } from './links/send-links.js';
import type { NotificationsModule } from './notifications/notifications.js';
import { createConfigRoute } from './routes/config.js';
import { createFilesRoute } from './routes/files.js';
import { healthRoute } from './routes/health.js';
import { createNotificationsRoute } from './routes/notifications.js';
import { createPublicDownloadTicketsRoute } from './routes/public-download-tickets.js';
import { createPublicReceiveLinksRoute } from './routes/public-receive-links.js';
import { createPublicSendLinksRoute } from './routes/public-send-links.js';
import { createPublicUploadTicketsRoute } from './routes/public-upload-tickets.js';
import { createReceiveLinksRoute } from './routes/receive-links.js';
import { createSendLinksRoute } from './routes/send-links.js';
import { createSetupRoute } from './routes/setup.js';
import { createLocalStorageRoute } from './routes/storage.js';
import { jsonError, logServerError } from './http/errors.js';
import { createSecurityHeadersMiddleware } from './http/security-headers.js';
import { createAdminOriginGuard } from './security/origin.js';
import {
  createRateLimitMiddleware,
  FixedWindowRateLimiter,
  rateLimitedBody,
  type RateLimiters,
} from './security/rate-limit.js';
import type { StorageProvider } from './storage/index.js';
import type { DownloadTicketsModule } from './tickets/download-tickets.js';
import type { UploadTicketsModule } from './tickets/upload-tickets.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Cap for multipart-complete bodies: up to 10,000 `{partNumber, etag}` entries.
 * One worst-case entry is `{"partNumber":10000,"etag":"\"<etag>\""},`: 31 bytes
 * of keys and punctuation plus the ETag, whose two quotes each gain a backslash.
 * An S3 ETag is 34 characters (32 hex plus quotes), so 31 + 36 = 67 bytes per
 * entry and 670,000 bytes for 10,000 parts. The local backend's ETag is a quoted
 * SHA-256 (66 characters), so 99 bytes per entry and 990,000 bytes. Both fit
 * under 1 MiB with room for the `{"parts":[...]}` wrapper and a password.
 */
const MULTIPART_COMPLETE_MAX_BYTES = 1 * MiB;

/** Bucket for failed sign-ins from all addresses (see the sign-in middleware). */
const AUTH_GLOBAL_FAILURES_KEY = 'auth-fail:global';

/**
 * Body-size limit for JSON control-plane routes. It rejects on `Content-Length`
 * up front and counts streamed bytes for chunked bodies, answering 413
 * `payload_too_large`. Upload bytes never pass through these routes; they go
 * to presigned storage URLs, so `/api/storage/o/*` is deliberately left uncapped
 * (the signed `cl` bounds those).
 */
function jsonBodyLimit(maxSize: number) {
  return bodyLimit({ maxSize, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });
}

/**
 * Build the Hono application. The API lives under `/api/*`; everything else is
 * served from the built frontend.
 *
 * In production the frontend lives at `config.webDistDir` and we serve its
 * assets statically with an SPA fallback so any non-API GET returns
 * `index.html` (client-side routing works without 404s).
 *
 * In development we don't serve static assets at all — the Vite dev server
 * does, and proxies `/api/*` to this Hono instance.
 */
export interface AppModules {
  authModule: AuthModule;
  receiveLinksModule: ReceiveLinksModule;
  sendLinksModule: SendLinksModule;
  uploadTicketsModule: UploadTicketsModule;
  downloadTicketsModule: DownloadTicketsModule;
  filesModule: FilesModule;
  notificationsModule: NotificationsModule;
  storage: StorageProvider;
}

export function createApp(config: AppConfig, modules: AppModules): Hono {
  const {
    authModule,
    receiveLinksModule,
    sendLinksModule,
    uploadTicketsModule,
    downloadTicketsModule,
    filesModule,
    notificationsModule,
    storage,
  } = modules;
  const app = new Hono();
  const { rateLimit } = config.security;
  const limiters: RateLimiters = {
    /** Brute-force and setup buckets. Never shares capacity with high-volume public traffic. */
    auth: new FixedWindowRateLimiter(rateLimit.maxTrackedKeys),
    /** Upload, ticket, part-URL, confirm and public-lookup buckets. */
    public: new FixedWindowRateLimiter(rateLimit.maxTrackedKeys),
  };

  app.use('*', createSecurityHeadersMiddleware(config));
  app.onError((err, c) => {
    logServerError('http.unhandled', err, {
      method: c.req.method,
      path: c.req.path,
    });
    return jsonError(c, 500, 'internal_error');
  });

  // Request-body caps, registered before any router so they run first. Hono
  // runs every matching middleware, so the generic public cap skips the public
  // multipart-complete path, which gets its own larger cap.
  const publicBodyLimit = jsonBodyLimit(64 * KiB);
  app.use('/api/public/*', (c, next) =>
    c.req.path.endsWith('/upload/multipart/complete') ? next() : publicBodyLimit(c, next),
  );
  app.use(
    '/api/public/upload-tickets/:ticketId/upload/multipart/complete',
    jsonBodyLimit(MULTIPART_COMPLETE_MAX_BYTES),
  );
  app.use(
    '/api/send-links/:linkId/files/multipart/:ticketId/complete',
    jsonBodyLimit(MULTIPART_COMPLETE_MAX_BYTES),
  );
  app.use('/api/setup', jsonBodyLimit(16 * KiB));
  app.use('/api/auth/*', jsonBodyLimit(16 * KiB));

  app.use(
    '/api/auth/sign-in/*',
    createRateLimitMiddleware(config.security, limiters.auth, (c, ip) => {
      if (c.req.method.toUpperCase() !== 'POST') return [];
      return [{ key: `auth:${ip}`, limit: rateLimit.auth }];
    }),
  );

  // Failed sign-ins from every address share one budget. Better Auth does the
  // credential check, so this inspects the budget before the handler and
  // counts the attempt only when it answers 401 (its status for a bad
  // username or password). A single-admin instance has one account, so this
  // is a per-account cap. Trade-off: while an attack exhausts it, the admin is
  // locked out too; that is accepted because the lockout ends with the window.
  // The bucket lives in its own one-key limiter: in `limiters.auth`, an
  // attacker with many addresses could evict it with fresh `auth:<ip>` keys.
  const signInFailures = new FixedWindowRateLimiter(1);
  app.use('/api/auth/sign-in/username', async (c, next) => {
    if (!rateLimit.enabled || c.req.method.toUpperCase() !== 'POST') return next();

    const budget = signInFailures.inspect(AUTH_GLOBAL_FAILURES_KEY, rateLimit.authGlobalFailures);
    if (!budget.allowed) {
      c.header('Retry-After', String(budget.retryAfterSeconds));
      return c.json(rateLimitedBody, 429);
    }

    await next();
    if (c.res.status === 401) {
      signInFailures.consume(AUTH_GLOBAL_FAILURES_KEY, rateLimit.authGlobalFailures);
    }
  });

  // Better Auth exposes its own fetch handler at /api/auth/*. It is not a
  // Hono router — it's a single fetch handler — so we wire it via `app.all`
  // rather than `app.route`. Everything under /api/auth (sign-in, sign-out,
  // get-session, ...) is handled here. Public signup is sealed by
  // `disableSignUp: true` in the auth options, so /api/auth/sign-up/email
  // and /api/auth/sign-up/username both reject.
  app.all('/api/auth/*', (c) => authModule.auth.handler(c.req.raw));

  const api = new Hono();
  api.route('/health', healthRoute);
  api.route('/config', createConfigRoute(config.storage));
  // Setup creates the admin without a session, so it gets the same Origin
  // check as the admin surfaces. The guard only acts on mutating methods, so
  // `GET /api/setup` stays open to the SPA.
  const adminOriginGuard = createAdminOriginGuard(config);
  api.use('/setup', adminOriginGuard);
  api.route('/setup', createSetupRoute(authModule, config.security, limiters.auth));

  // Admin (authed) surfaces.
  for (const prefix of ['/receive-links', '/send-links', '/files', '/notifications']) {
    api.use(prefix, adminOriginGuard);
    api.use(`${prefix}/*`, adminOriginGuard);
  }
  api.route(
    '/receive-links',
    createReceiveLinksRoute(authModule, receiveLinksModule, filesModule, storage),
  );
  api.route(
    '/send-links',
    createSendLinksRoute(authModule, sendLinksModule, uploadTicketsModule, filesModule),
  );
  api.route('/files', createFilesRoute(authModule, filesModule, storage));
  api.route('/notifications', createNotificationsRoute(authModule, notificationsModule));

  // Public (unauthed, policy-gated) surfaces. Kept under `/api/public/*` so
  // the boundary is obvious in route maps and reverse-proxy rules.
  const publicApi = new Hono();
  publicApi.route(
    '/receive-links',
    createPublicReceiveLinksRoute(
      receiveLinksModule,
      uploadTicketsModule,
      config.security,
      limiters,
    ),
  );
  publicApi.route(
    '/send-links',
    createPublicSendLinksRoute(
      sendLinksModule,
      filesModule,
      downloadTicketsModule,
      config.security,
      limiters,
    ),
  );
  publicApi.route(
    '/upload-tickets',
    createPublicUploadTicketsRoute(uploadTicketsModule, config.security, limiters.public),
  );
  publicApi.route(
    '/download-tickets',
    createPublicDownloadTicketsRoute(downloadTicketsModule, config.security, limiters.public),
  );
  api.route('/public', publicApi);

  app.route('/api', api);

  // Local storage backend routes. Mounted only when the operator chose the
  // local backend; in S3 mode these routes are not registered so a
  // misconfigured deploy cannot accidentally serve bytes from a directory.
  if (config.storage.backend === 'local') {
    app.route('/api/storage/o', createLocalStorageRoute(config.storage, uploadTicketsModule));
  }

  if (config.nodeEnv === 'production') {
    const webRoot = resolve(config.webDistDir);
    const indexHtmlPath = join(webRoot, 'index.html');

    if (!existsSync(indexHtmlPath)) {
      throw new Error(`Frontend build not found at ${indexHtmlPath}. Did the web workspace build?`);
    }

    const indexHtml = readFileSync(indexHtmlPath, 'utf8');

    // Catch-all GET handler for the frontend. Tries to resolve the request
    // path as a static file under `webRoot`; falls back to `index.html` so
    // client-side routes (`/links/receive/new`, etc.) survive a hard refresh.
    //
    // A small bespoke middleware avoids `@hono/node-server`'s `serveStatic`,
    // which is rooted relative to cwd and would couple our runtime behaviour
    // to where the process was started.
    app.get('*', (c) => {
      // Never intercept API routes — Hono will already have matched them, but
      // belt-and-braces in case of future overlap.
      if (c.req.path.startsWith('/api/')) return c.notFound();

      // Strip leading slash, then `normalize` to collapse `..` segments before
      // resolving against the root. The post-resolve `startsWith` check is the
      // real guard against path traversal.
      const rel = normalize(c.req.path.replace(/^\/+/, ''));
      const candidate = resolve(webRoot, rel);

      if (
        rel.length > 0 &&
        candidate.startsWith(webRoot + '/') &&
        existsSync(candidate) &&
        statSync(candidate).isFile()
      ) {
        const body = readFileSync(candidate);
        return c.body(body, 200, { 'Content-Type': contentTypeFor(candidate) });
      }

      return c.html(indexHtml);
    });
  }

  return app;
}
