import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';

import type { AuthModule } from './auth/index.js';
import type { AppConfig } from './config.js';
import type { FilesModule } from './files/files.js';
import type { ReceiveLinksModule } from './links/receive-links.js';
import type { SendLinksModule } from './links/send-links.js';
import { createFilesRoute } from './routes/files.js';
import { healthRoute } from './routes/health.js';
import { createPublicDownloadTicketsRoute } from './routes/public-download-tickets.js';
import { createPublicReceiveLinksRoute } from './routes/public-receive-links.js';
import { createPublicSendLinksRoute } from './routes/public-send-links.js';
import { createPublicUploadTicketsRoute } from './routes/public-upload-tickets.js';
import { createReceiveLinksRoute } from './routes/receive-links.js';
import { createSendLinksRoute } from './routes/send-links.js';
import { createSetupRoute } from './routes/setup.js';
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
    storage,
  } = modules;
  const app = new Hono();

  // Better Auth exposes its own fetch handler at /api/auth/*. It is not a
  // Hono router — it's a single fetch handler — so we wire it via `app.all`
  // rather than `app.route`. Everything under /api/auth (sign-in, sign-out,
  // get-session, ...) is handled here. Public signup is sealed by
  // `disableSignUp: true` in the auth options, so /api/auth/sign-up/email
  // and /api/auth/sign-up/username both reject.
  app.all('/api/auth/*', (c) => authModule.auth.handler(c.req.raw));

  const api = new Hono();
  api.route('/health', healthRoute);
  api.route('/setup', createSetupRoute(authModule));

  // Admin (authed) surfaces.
  api.route('/receive-links', createReceiveLinksRoute(authModule, receiveLinksModule, filesModule));
  api.route(
    '/send-links',
    createSendLinksRoute(authModule, sendLinksModule, uploadTicketsModule, filesModule),
  );
  api.route('/files', createFilesRoute(authModule, filesModule, storage));

  // Public (unauthed, policy-gated) surfaces. Kept under `/api/public/*` so
  // the boundary is obvious in route maps and reverse-proxy rules.
  const publicApi = new Hono();
  publicApi.route(
    '/receive-links',
    createPublicReceiveLinksRoute(receiveLinksModule, uploadTicketsModule),
  );
  publicApi.route(
    '/send-links',
    createPublicSendLinksRoute(sendLinksModule, filesModule, downloadTicketsModule),
  );
  publicApi.route('/upload-tickets', createPublicUploadTicketsRoute(uploadTicketsModule));
  publicApi.route('/download-tickets', createPublicDownloadTicketsRoute(downloadTicketsModule));
  api.route('/public', publicApi);

  app.route('/api', api);

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
