import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createApp } from './app.js';
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

  openDatabase(config.databasePath, migrationsFolder);

  const app = createApp(config);

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[fileharbor] listening on http://0.0.0.0:${info.port}`);
  });
}

main().catch((err) => {
  console.error('[fileharbor] fatal:', err);
  process.exit(1);
});
