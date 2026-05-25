import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

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
  /** Auth-related settings. */
  auth: AuthConfig;
  /** S3-compatible storage settings. */
  storage: StorageConfig;
}

export interface StorageConfig {
  /**
   * Endpoint URL for the S3-compatible service. Required.
   * Examples:
   *   - AWS S3:        https://s3.us-east-1.amazonaws.com
   *   - Cloudflare R2: https://<acct>.r2.cloudflarestorage.com
   *   - MinIO:         http://localhost:9000
   */
  endpoint: string;
  /** AWS region. Required by the SDK even for non-AWS providers (use any value, e.g. `auto`). */
  region: string;
  /** Access key id. Required. */
  accessKeyId: string;
  /** Secret access key. Required. */
  secretAccessKey: string;
  /** Bucket name. Required. */
  bucket: string;
  /**
   * When true, addresses objects as `endpoint/bucket/key` rather than
   * `bucket.endpoint/key`. Required for MinIO and certain R2 setups.
   */
  forcePathStyle: boolean;
  /**
   * TTL applied to presigned PUT / GET / DELETE URLs, in seconds. Kept short
   * (minutes, not hours) per PRD: a leaked URL should not be useful for long.
   * Default: 300s (5 minutes).
   */
  presignTtlSeconds: number;
}

export interface AuthConfig {
  /**
   * Secret used by Better Auth to sign session cookies. Required in
   * production; auto-generated (and logged once) in development if absent so
   * the dev loop has no friction.
   */
  secret: string;
  /**
   * Public-facing base URL Better Auth uses to construct callback URLs and to
   * pin the cookie host. Defaults to `http://localhost:${port}` when unset,
   * which is fine for dev but should be set explicitly in production.
   */
  baseUrl: string;
  /**
   * Optional admin credentials. When both are set AND no user exists at boot,
   * the system seeds the single admin account so headless deploys work
   * without anyone hitting `/setup`.
   */
  adminSeed: AdminSeed | null;
}

export interface AdminSeed {
  username: string;
  password: string;
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

function resolveAuthSecret(raw: string | undefined, nodeEnv: AppConfig['nodeEnv']): string {
  if (raw && raw.length > 0) return raw;
  if (nodeEnv === 'production') {
    throw new Error(
      'BETTER_AUTH_SECRET is required in production. Generate one with `openssl rand -hex 32`.',
    );
  }
  // Dev/test convenience: ephemeral secret per process. Sessions invalidate on
  // restart, which is fine for local dev and avoids surprising the operator
  // with a placeholder secret committed to disk.
  const generated = randomBytes(32).toString('hex');
  console.warn(
    '[fileharbor] BETTER_AUTH_SECRET unset; generated an ephemeral secret for this process. ' +
      'Sessions will not survive a restart. Set BETTER_AUTH_SECRET in `.env` to make them stable.',
  );
  return generated;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function requireEnv(env: Env, key: string): string {
  const raw = env[key];
  if (!raw || raw.trim() === '') {
    throw new Error(`${key} is required.`);
  }
  return raw.trim();
}

function resolveStorageConfig(env: Env): StorageConfig {
  const endpoint = requireEnv(env, 'S3_ENDPOINT');
  // Validate it parses as a URL — catches obvious typos early.
  try {
    void new URL(endpoint);
  } catch {
    throw new Error(`S3_ENDPOINT is not a valid URL: ${endpoint}`);
  }

  const region = env.S3_REGION?.trim() || 'auto';
  const accessKeyId = requireEnv(env, 'S3_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv(env, 'S3_SECRET_ACCESS_KEY');
  const bucket = requireEnv(env, 'S3_BUCKET');
  const forcePathStyle = parseBool(env.S3_FORCE_PATH_STYLE, false);

  const ttlRaw = env.S3_PRESIGN_TTL_SECONDS;
  const presignTtlSeconds = ttlRaw ? Number.parseInt(ttlRaw, 10) : 300;
  if (
    !Number.isInteger(presignTtlSeconds) ||
    presignTtlSeconds <= 0 ||
    presignTtlSeconds > 7 * 24 * 3600
  ) {
    throw new Error(
      `S3_PRESIGN_TTL_SECONDS must be a positive integer <= 604800 (7 days, the SigV4 maximum). Got: ${ttlRaw}`,
    );
  }

  return {
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    bucket,
    forcePathStyle,
    presignTtlSeconds,
  };
}

function resolveAdminSeed(env: Env): AdminSeed | null {
  const username = env.ADMIN_USERNAME?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!username && !password) return null;
  if (!username || !password) {
    throw new Error(
      'ADMIN_USERNAME and ADMIN_PASSWORD must be set together (or neither). One is missing.',
    );
  }
  return { username, password };
}

export function loadConfig(env: Env = process.env as Env): AppConfig {
  const nodeEnvRaw = env.NODE_ENV ?? 'development';
  const nodeEnv: AppConfig['nodeEnv'] =
    nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';

  const port = parsePort(env.PORT);

  const dataDir = resolve(env.DATA_DIR ?? './data');
  const databasePath = resolveDatabasePath(env.DATABASE_URL, dataDir);

  // Ensure the directory holding the DB exists before sqlite tries to open it.
  mkdirSync(dirname(databasePath), { recursive: true });

  // The web dist is colocated with the server bundle in production builds.
  // In dev we don't serve static assets from disk — Vite handles that.
  const webDistDir = env.WEB_DIST_DIR ? resolve(env.WEB_DIST_DIR) : resolve('./web');

  const auth: AuthConfig = {
    secret: resolveAuthSecret(env.BETTER_AUTH_SECRET, nodeEnv),
    baseUrl: env.BETTER_AUTH_URL?.trim() || `http://localhost:${port}`,
    adminSeed: resolveAdminSeed(env),
  };

  const storage = resolveStorageConfig(env);

  return Object.freeze({
    port,
    nodeEnv,
    dataDir,
    databasePath,
    webDistDir,
    auth,
    storage,
  });
}
