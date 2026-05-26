import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createApp } from './app.js';
import { createAuthModule, maybeSeedAdmin } from './auth/index.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';
import { createFilesModule } from './files/files.js';
import { createReceiveLinksModule } from './links/receive-links.js';
import { createSendLinksModule } from './links/send-links.js';
import { createNotificationsModule } from './notifications/notifications.js';
import { createStorageProvider, verifyStorage } from './storage/index.js';
import { createDownloadTicketsModule } from './tickets/download-tickets.js';
import { createTicketSweeper } from './tickets/sweep.js';
import { createUploadTicketsModule } from './tickets/upload-tickets.js';

/**
 * Entry point. Resolves config from env, opens the SQLite DB (running pending
 * Drizzle migrations in-process before the HTTP server starts listening),
 * builds the Hono app, then binds the port.
 *
 * Single entrypoint by design: migrations are not a separate `docker exec`
 * step. The same `node dist/index.js` invocation that runs in production runs
 * them on every boot. Idempotency is handled by the Drizzle migrator.
 *

 * Boot order:
 *   1. Resolve config (throws on missing required secrets in production).
 *   2. Open DB + apply migrations.
 *   3. Construct the storage provider and verify the configured bucket with
 *      a HeadBucket probe. Failure aborts boot before any traffic is served —
 *      a misconfigured bucket should surface as a non-zero container exit,
 *      not as failing requests later.
 *   4. Construct the auth module (Better Auth instance).
 *   5. Optionally seed the admin user from env (`ADMIN_USERNAME`/`ADMIN_PASSWORD`).
 *      Done before `serve()` so a fresh container with the seed envs comes up
 *      already past first-run setup.
 *   6. Bind the port.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // Resolve the migrations folder relative to this file so it works both in
  // dev (src/) and in the built image (dist/).
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../drizzle');

  console.log(
    `[fileharbor] starting (env=${config.nodeEnv}, db=${config.databasePath}, port=${config.port})`,
  );

  const db = openDatabase(config.databasePath, migrationsFolder);

  const storage = createStorageProvider(config.storage);
  if (config.storage.backend === 'local') {
    console.log(
      `[fileharbor] verifying storage (backend=local, ` +
        `objectsDir=${config.storage.objectsDir}, ` +
        `presignTtl=${config.storage.presignTtlSeconds}s)`,
    );
  } else {
    console.log(
      `[fileharbor] verifying storage (backend=s3, ` +
        `endpoint=${config.storage.endpoint}, bucket=${config.storage.bucket}, ` +
        `pathStyle=${config.storage.forcePathStyle}, ` +
        `presignTtl=${config.storage.presignTtlSeconds}s)`,
    );
  }
  await verifyStorage(storage, config.storage);
  console.log('[fileharbor] storage ok');

  const authModule = createAuthModule(db, config);

  await maybeSeedAdmin(authModule, config);

  // Assemble domain modules. Construction is cheap (no I/O) — we wire them
  // here, in `main()`, so `createApp` only sees module facades rather than
  // raw `db`/`storage`. That keeps route code testable: a fake module
  // implementation can be substituted without monkey-patching SQL.
  const receiveLinksModule = createReceiveLinksModule(db);
  const sendLinksModule = createSendLinksModule(db);
  const filesModule = createFilesModule(db);
  const notificationsModule = createNotificationsModule(db);
  const uploadTicketsModule = createUploadTicketsModule(
    db,
    storage,
    receiveLinksModule,
    sendLinksModule,
    filesModule,
    notificationsModule,
  );
  const downloadTicketsModule = createDownloadTicketsModule(
    db,
    storage,
    sendLinksModule,
    filesModule,
  );

  const app = createApp(config, {
    authModule,
    receiveLinksModule,
    sendLinksModule,
    uploadTicketsModule,
    downloadTicketsModule,
    filesModule,
    notificationsModule,
    storage,
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[fileharbor] listening on http://0.0.0.0:${info.port}`);
  });

  // ----- Background ticket sweep (issue #10) --------------------------------
  // Runs inside this same Node process — no separate worker. The sweep:
  //   - expires `pending` upload/download tickets past TTL + grace
  //   - deletes terminal tickets older than the retention window
  // See `tickets/sweep.ts` for the race-safety and overlap-safety story.
  const ticketSweeper = createTicketSweeper({
    db,
    downloadTicketsModule,
    presignTtlSeconds: config.storage.presignTtlSeconds,
    intervalSeconds: config.ticketSweep.intervalSeconds,
    pendingGraceSeconds: config.ticketSweep.pendingGraceSeconds,
    retentionSeconds: config.ticketSweep.retentionSeconds,
  });

  console.log(
    `[fileharbor] ticket sweep enabled (interval=${config.ticketSweep.intervalSeconds}s, ` +
      `pendingGrace=${config.ticketSweep.pendingGraceSeconds}s, ` +
      `retention=${config.ticketSweep.retentionSeconds}s)`,
  );

  // Fire one pass immediately so a freshly-restarted server cleans whatever
  // accumulated while it was down. Fire-and-forget so it doesn't block boot
  // logging or the first inbound request. `runOnce` catches its own errors.
  void ticketSweeper
    .runOnce(Math.floor(Date.now() / 1000))
    .then((counters) => {
      const total =
        counters.expiredUploadTickets +
        counters.expiredDownloadTickets +
        counters.deletedUploadTickets +
        counters.deletedDownloadTickets;
      if (total > 0) {
        console.log('[fileharbor] initial sweep complete', counters);
      }
    })
    .catch((err) => {
      console.error('[fileharbor] initial sweep threw', err);
    });

  ticketSweeper.start();

  // ----- Graceful shutdown --------------------------------------------------
  // Handle SIGTERM (docker stop, k8s) and SIGINT (Ctrl-C in dev). On either:
  //   1. Stop accepting new HTTP connections (server.close).
  //   2. Stop the sweeper (cancel its timer; await any in-flight pass).
  //   3. Exit.
  //
  // If a second signal arrives during shutdown, force-exit so a stuck
  // connection can't keep the container alive forever.
  let shuttingDown = false;
  const shutdown = (signal: 'SIGTERM' | 'SIGINT'): void => {
    if (shuttingDown) {
      console.warn(`[fileharbor] received ${signal} during shutdown; forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`[fileharbor] received ${signal}, shutting down`);

    server.close((err) => {
      if (err) {
        console.error('[fileharbor] http server close error', err);
      } else {
        console.log('[fileharbor] http server closed');
      }
    });

    // Drain the sweep concurrently with the http close. Both should complete
    // promptly; we exit once the sweeper has settled. server.close is
    // best-effort here — open connections may hold it longer than the sweep.
    ticketSweeper
      .stop()
      .then(() => {
        console.log('[fileharbor] ticket sweep stopped');
        process.exit(0);
      })
      .catch((err) => {
        console.error('[fileharbor] ticket sweep stop error', err);
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[fileharbor] fatal:', err);
  process.exit(1);
});
