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
import { createStorageProvider, verifyStorage } from './storage/index.js';
import { createDownloadTicketsModule } from './tickets/download-tickets.js';
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
  console.log(
    `[fileharbor] verifying storage (endpoint=${config.storage.endpoint}, bucket=${config.storage.bucket}, ` +
      `pathStyle=${config.storage.forcePathStyle}, presignTtl=${config.storage.presignTtlSeconds}s)`,
  );
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
  const uploadTicketsModule = createUploadTicketsModule(
    db,
    storage,
    receiveLinksModule,
    sendLinksModule,
    filesModule,
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
    storage,
  });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[fileharbor] listening on http://0.0.0.0:${info.port}`);
  });
}

main().catch((err) => {
  console.error('[fileharbor] fatal:', err);
  process.exit(1);
});
