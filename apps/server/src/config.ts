import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Runtime configuration. All values are env-var-driven; the app never reads a
 * config file. Resolved once at boot so the rest of the codebase can import a
 * frozen object instead of touching `process.env` directly.
 */
export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  dataDir: string;
  databasePath: string;
  /** Absolute path to the directory containing the built frontend assets. */
  webDistDir: string;
}

type Env = Record<string, string | undefined>;

function parsePort(raw: string | undefined): number {
  const port = raw ? Number.parseInt(raw, 10) : 3000;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

/**
 * Resolve `DATABASE_URL` into a filesystem path. Accepts either a raw path
 * (`./data/x.db`, `/data/x.db`) or a `file:` URL (`file:./data/x.db`,
 * `file:///data/x.db`). Falls back to `<dataDir>/fileharbor.db` when unset.
 */
function resolveDatabasePath(raw: string | undefined, dataDir: string): string {
  if (!raw) return resolve(dataDir, 'fileharbor.db');
  if (raw.startsWith('file:')) {
    // file:./relative, file:/abs, file:///abs all parse via URL when prefixed.
    const url = new URL(raw);
    // url.pathname is decoded; for `file:./x` Node gives us `./x` in pathname.
    return isAbsolute(url.pathname) ? url.pathname : resolve(url.pathname);
  }
  return isAbsolute(raw) ? raw : resolve(raw);
}

export function loadConfig(env: Env = process.env as Env): AppConfig {
  const nodeEnvRaw = env.NODE_ENV ?? 'development';
  const nodeEnv: AppConfig['nodeEnv'] =
    nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';

  const dataDir = resolve(env.DATA_DIR ?? './data');
  const databasePath = resolveDatabasePath(env.DATABASE_URL, dataDir);

  // Ensure the directory holding the DB exists before sqlite tries to open it.
  mkdirSync(dirname(databasePath), { recursive: true });

  // The web dist is colocated with the server bundle in production builds.
  // In dev we don't serve static assets from disk — Vite handles that.
  const webDistDir = env.WEB_DIST_DIR ? resolve(env.WEB_DIST_DIR) : resolve('./web');

  return Object.freeze({
    port: parsePort(env.PORT),
    nodeEnv,
    dataDir,
    databasePath,
    webDistDir,
  });
}
