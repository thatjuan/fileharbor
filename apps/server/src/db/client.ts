import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Open a SQLite database at `path`, wrap it in a Drizzle client, and apply any
 * pending migrations from `migrationsFolder`. Pragmas (WAL, foreign keys) are
 * set up-front so every connection sees consistent behaviour.
 *
 * Idempotency: `migrate()` records applied migrations in `__drizzle_migrations`
 * and skips anything already applied, so this function is safe to call on every
 * container start.
 */
export function openDatabase(path: string, migrationsFolder: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
