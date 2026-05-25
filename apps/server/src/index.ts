import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createApp } from './app.js';
import { createAuthModule, maybeSeedAdmin } from './auth/index.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';

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
 *   3. Construct the auth module (Better Auth instance).
 *   4. Optionally seed the admin user from env (`ADMIN_USERNAME`/`ADMIN_PASSWORD`).
 *      Done before `serve()` so a fresh container with the seed envs comes up
 *      already past first-run setup.
 *   5. Bind the port.
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

  const authModule = createAuthModule(db, config);

  await maybeSeedAdmin(authModule, config);

  const app = createApp(config, authModule);

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[fileharbor] listening on http://0.0.0.0:${info.port}`);
  });
}

main().catch((err) => {
  console.error('[fileharbor] fatal:', err);
  process.exit(1);
});
