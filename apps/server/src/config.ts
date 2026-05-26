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
  /**
   * Storage backend settings. Discriminated on `backend`:
   *   - `s3`    — external S3-compatible bucket (v1 behaviour).
   *   - `local` — bytes on the same data volume as the SQLite DB. Presigned
   *               URLs point at File Harbor's own routes and are HMAC-signed.
   */
  storage: StorageConfig;
  /** Ticket-cleanup background sweep (issue #10). */
  ticketSweep: TicketSweepConfig;
  /** HTTP boundary hardening: rate limits, proxy trust, and response headers. */
  security: SecurityConfig;
  /** Cloudflare Tunnel publication settings (issue #33). */
  tunnel: TunnelConfig;
}

export interface WindowLimitConfig {
  max: number;
  windowSeconds: number;
}

export interface RateLimitConfig {
  enabled: boolean;
  maxTrackedKeys: number;
  auth: WindowLimitConfig;
  setup: WindowLimitConfig;
  publicLink: WindowLimitConfig;
  publicTicket: WindowLimitConfig;
  publicPartUrls: WindowLimitConfig;
  publicConfirm: WindowLimitConfig;
}

export interface SecurityHeadersConfig {
  enabled: boolean;
  hstsEnabled: boolean;
  hstsMaxAgeSeconds: number;
  hstsIncludeSubDomains: boolean;
  hstsPreload: boolean;
  cspExtraConnectSrc: string[];
}

export interface SecurityConfig {
  /** Whether to trust forwarded client-IP headers. Keep false unless behind a trusted proxy. */
  trustProxyHeaders: boolean;
  rateLimit: RateLimitConfig;
  headers: SecurityHeadersConfig;
}

/**
 * Cloudflare Tunnel publication settings. When `enabled`, the container also
 * runs `cftunn` alongside the Node server to publish the service on `domain`
 * via a named Cloudflare Tunnel. The Node process itself does not consume the
 * API token — it's read by the `cftunn` subprocess from the same env — so the
 * token is intentionally absent from this config object.
 */
export interface TunnelConfig {
  enabled: boolean;
  /** Custom domain, e.g. `files.example.com`. Null when disabled. */
  domain: string | null;
}

/**
 * Ticket-cleanup sweep tuning. The sweep runs inside the existing Node process
 * (no external worker) and does two things every `intervalSeconds`:
 *   1. Transition pending tickets older than (presign TTL + grace) to expired.
 *   2. Delete tickets in terminal states older than `retentionSeconds`.
 *
 * Defaults are reasonable for a typical self-hosted deploy. Operators with
 * specific retention needs can override via env.
 */
export interface TicketSweepConfig {
  /** How often the sweep wakes up, in seconds. Default 60. */
  intervalSeconds: number;
  /**
   * Buffer added to the presign TTL before a pending ticket is considered
   * expired. Guards against clock skew between server and storage provider,
   * and against a ticket minted seconds before a user finalises. Default 60.
   */
  pendingGraceSeconds: number;
  /**
   * Retention window for terminal tickets (expired / failed / completed).
   * Rows older than `now - retentionSeconds` are deleted entirely.
   * Default 7 days. The completed-ticket file rows are NOT touched —
   * they're independently owned by the `files` table.
   */
  retentionSeconds: number;
}

export type StorageBackend = 'local' | 's3';

/**
 * Storage configuration. Discriminated union; branch on `backend`.
 *
 * Only the fields relevant to the selected backend are read at boot — an
 * operator running in `local` mode does not need to set any `S3_*` var, and
 * an operator running in `s3` mode does not need to set the local vars.
 */
export type StorageConfig = S3StorageConfig | LocalStorageConfig;

/**
 * Multipart-upload knobs. Shared across both storage backends — the protocol
 * looks the same to the frontend regardless of where bytes ultimately live.
 *
 * Defaults are tuned for a typical self-hosted deploy: 100 MiB threshold
 * keeps small / medium files on the cheaper single-PUT path; 16 MiB parts
 * keep RAM bounded on the server-side concatenation loop without producing
 * too many parts for files up to ~160 GiB. For files above that, the server
 * auto-bumps the part size to stay under S3's 10 000-part cap.
 */
export interface MultipartConfig {
  /** File size above which the client uses the multipart protocol. Default 100 MiB. */
  thresholdBytes: number;
  /** Server-chosen part size (auto-bumped if needed to keep parts <= 10000). Default 16 MiB. */
  partSizeBytes: number;
  /** Maximum seconds a multipart session may sit pending before sweep aborts it. Default 7200. */
  ttlSeconds: number;
  /** Hard ceiling on single-PUT and multipart object size. Default depends on backend. */
  maxObjectSizeBytes: number;
}

export interface S3StorageConfig {
  backend: 's3';
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
  /** Multipart-upload knobs. */
  multipart: MultipartConfig;
}

export interface LocalStorageConfig {
  backend: 'local';
  /**
   * Filesystem directory holding object bytes. Default: `${DATA_DIR}/objects`.
   * Created on boot if missing; an unwritable directory aborts startup.
   */
  objectsDir: string;
  /**
   * HMAC secret used to sign local-mode presigned URLs. Required in production;
   * auto-generated with a one-time warning in development (same pattern as
   * `BETTER_AUTH_SECRET`). NOT shared with the auth secret on purpose —
   * rotating one should not invalidate the other.
   */
  signingSecret: string;
  /**
   * TTL applied to local presigned URLs, in seconds. Default: 300s.
   */
  presignTtlSeconds: number;
  /** Multipart-upload knobs. */
  multipart: MultipartConfig;
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

function resolveStorageConfig(
  env: Env,
  nodeEnv: AppConfig['nodeEnv'],
  dataDir: string,
): StorageConfig {
  // Default `local`: a fresh container with only `BETTER_AUTH_SECRET` +
  // `STORAGE_SIGNING_SECRET` (and a data volume) boots and works end-to-end.
  // Operators who want off-host bytes opt in with `STORAGE_BACKEND=s3`.
  const backendRaw = (env.STORAGE_BACKEND ?? 'local').trim().toLowerCase();
  if (backendRaw !== 's3' && backendRaw !== 'local') {
    throw new Error(
      `STORAGE_BACKEND must be 'local' or 's3'. Got: ${JSON.stringify(env.STORAGE_BACKEND)}`,
    );
  }
  const backend: StorageBackend = backendRaw;
  if (backend === 'local') return resolveLocalStorageConfig(env, nodeEnv, dataDir);
  return resolveS3StorageConfig(env);
}

function resolveS3StorageConfig(env: Env): S3StorageConfig {
  const endpoint = requireS3Env(env, 'S3_ENDPOINT');
  // Validate it parses as a URL — catches obvious typos early.
  try {
    void new URL(endpoint);
  } catch {
    throw new Error(`S3_ENDPOINT is not a valid URL: ${endpoint}`);
  }

  const region = env.S3_REGION?.trim() || 'auto';
  const accessKeyId = requireS3Env(env, 'S3_ACCESS_KEY_ID');
  const secretAccessKey = requireS3Env(env, 'S3_SECRET_ACCESS_KEY');
  const bucket = requireS3Env(env, 'S3_BUCKET');
  const forcePathStyle = parseBool(env.S3_FORCE_PATH_STYLE, false);
  const presignTtlSeconds = parsePresignTtl(env.S3_PRESIGN_TTL_SECONDS, 'S3_PRESIGN_TTL_SECONDS');

  return {
    backend: 's3',
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    bucket,
    forcePathStyle,
    presignTtlSeconds,
    multipart: parseMultipartConfig(env, 's3'),
  };
}

function resolveLocalStorageConfig(
  env: Env,
  nodeEnv: AppConfig['nodeEnv'],
  dataDir: string,
): LocalStorageConfig {
  const objectsDirRaw = env.LOCAL_OBJECTS_DIR?.trim();
  const objectsDir = objectsDirRaw
    ? isAbsolute(objectsDirRaw)
      ? objectsDirRaw
      : resolve(objectsDirRaw)
    : resolve(dataDir, 'objects');

  const signingSecret = resolveSigningSecret(env.STORAGE_SIGNING_SECRET, nodeEnv);
  const presignTtlSeconds = parsePresignTtl(
    env.STORAGE_PRESIGN_TTL_SECONDS ?? env.S3_PRESIGN_TTL_SECONDS,
    'STORAGE_PRESIGN_TTL_SECONDS',
  );

  return {
    backend: 'local',
    objectsDir,
    signingSecret,
    presignTtlSeconds,
    multipart: parseMultipartConfig(env, 'local'),
  };
}

function requireS3Env(env: Env, key: string): string {
  const raw = env[key];
  if (!raw || raw.trim() === '') {
    throw new Error(
      `${key} is required when STORAGE_BACKEND=s3. ` +
        `(Tip: STORAGE_BACKEND=local stores bytes on the data volume and needs no S3_* vars.)`,
    );
  }
  return raw.trim();
}

function parsePresignTtl(raw: string | undefined, varName: string): number {
  const presignTtlSeconds = raw ? Number.parseInt(raw, 10) : 300;
  if (
    !Number.isInteger(presignTtlSeconds) ||
    presignTtlSeconds <= 0 ||
    presignTtlSeconds > 7 * 24 * 3600
  ) {
    throw new Error(`${varName} must be a positive integer <= 604800 (7 days). Got: ${raw}`);
  }
  return presignTtlSeconds;
}

function resolveSigningSecret(raw: string | undefined, nodeEnv: AppConfig['nodeEnv']): string {
  if (raw && raw.trim().length > 0) return raw.trim();
  if (nodeEnv === 'production') {
    throw new Error(
      'STORAGE_SIGNING_SECRET is required in production when STORAGE_BACKEND=local. ' +
        'Generate one with `openssl rand -hex 32`.',
    );
  }
  const generated = randomBytes(32).toString('hex');
  console.warn(
    '[fileharbor] STORAGE_SIGNING_SECRET unset; generated an ephemeral secret for this process. ' +
      'Presigned URLs will not survive a restart. Set STORAGE_SIGNING_SECRET in `.env` to make them stable.',
  );
  return generated;
}

/**
 * Resolve Cloudflare Tunnel settings. Paired-env validation mirrors
 * `resolveAdminSeed`: both vars unset is the disabled-by-default case, both
 * set enables the tunnel, exactly one set is an operator error and aborts
 * boot rather than silently disabling the feature.
 *
 * Validation rules:
 *   - Neither var set → disabled (`enabled: false`, `domain: null`).
 *   - Exactly one set → throw, naming the missing var.
 *   - Both set → domain must look like a hostname (one or more labels of
 *     alphanumerics + internal hyphens, separated by dots). Full validation
 *     happens downstream in `cftunn` / Cloudflare; this catches obvious typos.
 */
function resolveTunnelConfig(env: Env): TunnelConfig {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const domain = env.CLOUDFLARE_TUNNEL_DOMAIN?.trim();
  if (!token && !domain) return { enabled: false, domain: null };
  if (!token || !domain) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_TUNNEL_DOMAIN must be set together (or neither). ' +
        `Missing: ${!token ? 'CLOUDFLARE_API_TOKEN' : 'CLOUDFLARE_TUNNEL_DOMAIN'}.`,
    );
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(domain)) {
    throw new Error(`CLOUDFLARE_TUNNEL_DOMAIN is not a valid hostname: ${domain}`);
  }
  return { enabled: true, domain };
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

  const tunnel = resolveTunnelConfig(env);

  // baseUrl precedence: explicit env wins, tunnel-derived next, localhost
  // last. The tunnel-derived case is logged once at boot so an operator who
  // forgot to set BETTER_AUTH_URL can see what cookie host the server pinned.
  const explicitBaseUrl = env.BETTER_AUTH_URL?.trim();
  let baseUrl: string;
  if (explicitBaseUrl) {
    baseUrl = explicitBaseUrl;
  } else if (tunnel.enabled && tunnel.domain) {
    baseUrl = `https://${tunnel.domain}`;
    console.log(`[fileharbor] BETTER_AUTH_URL derived from CLOUDFLARE_TUNNEL_DOMAIN: ${baseUrl}`);
  } else {
    baseUrl = `http://localhost:${port}`;
  }

  const auth: AuthConfig = {
    secret: resolveAuthSecret(env.BETTER_AUTH_SECRET, nodeEnv),
    baseUrl,
    adminSeed: resolveAdminSeed(env),
  };

  const storage = resolveStorageConfig(env, nodeEnv, dataDir);
  const ticketSweep = resolveTicketSweepConfig(env);
  const security = resolveSecurityConfig(env, nodeEnv, baseUrl);

  return Object.freeze({
    port,
    nodeEnv,
    dataDir,
    databasePath,
    webDistDir,
    auth,
    storage,
    ticketSweep,
    security,
    tunnel,
  });
}

/**
 * Parse a positive-integer seconds env var with a default and clamping bounds.
 * Rejects non-integers and zero/negative values — the sweep needs sane numbers
 * and a misconfigured operator is better served by a hard error at boot than
 * by a silently disabled sweeper.
 */
function parsePositiveIntSeconds(
  raw: string | undefined,
  fallback: number,
  varName: string,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new Error(`${varName} must be a positive integer <= ${max}. Got: ${raw}`);
  }
  return n;
}

/**
 * Parse a positive-integer bytes env var with a default and bounds. Mirrors
 * `parsePositiveIntSeconds` shape — there's no semantic difference, but the
 * separate function name makes call sites self-documenting and the error
 * message can name "bytes" instead of "seconds".
 */
function parsePositiveIntBytes(
  raw: string | undefined,
  fallback: number,
  varName: string,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${varName} must be an integer in [${min}, ${max}] bytes. Got: ${raw}`);
  }
  return n;
}

/**
 * Resolve the multipart-upload knobs. Shared across both backends; the only
 * backend-specific default is the hard ceiling on object size — local mode
 * defaults to 50 GiB (sized for a typical self-hosted volume) while S3 mode
 * defaults to S3's own 5 TiB per-object limit.
 *
 * Boot validation:
 *   - `maxObjectSizeBytes` must be > `thresholdBytes` (otherwise multipart
 *     is unreachable: anything large enough to trip the threshold also
 *     overflows the ceiling).
 *   - `partSizeBytes * 10_000` must be >= `maxObjectSizeBytes` (S3's
 *     10 000-part cap must not be reachable as a runtime error — if it
 *     were, an operator with a 5 TiB ceiling and 16 MiB parts would
 *     discover the misconfiguration mid-upload).
 *   - Part size at least 5 MiB (S3 rule: all parts except the last must be
 *     >= 5 MiB) and at most 5 GiB (S3 rule: a single part is capped at 5 GiB).
 */
function parseMultipartConfig(env: Env, backend: StorageBackend): MultipartConfig {
  const ONE_MIB = 1024 * 1024;
  const ONE_GIB = 1024 * ONE_MIB;
  const ONE_TIB = 1024 * ONE_GIB;

  const thresholdBytes = parsePositiveIntBytes(
    env.STORAGE_MULTIPART_THRESHOLD_BYTES,
    100 * ONE_MIB,
    'STORAGE_MULTIPART_THRESHOLD_BYTES',
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const partSizeBytes = parsePositiveIntBytes(
    env.STORAGE_MULTIPART_PART_SIZE_BYTES,
    16 * ONE_MIB,
    'STORAGE_MULTIPART_PART_SIZE_BYTES',
    5 * ONE_MIB,
    5 * ONE_GIB,
  );
  const ttlSeconds = parsePositiveIntSeconds(
    env.STORAGE_MULTIPART_TTL_SECONDS,
    7200,
    'STORAGE_MULTIPART_TTL_SECONDS',
    365 * 24 * 3600,
  );
  if (ttlSeconds < 60) {
    throw new Error(
      `STORAGE_MULTIPART_TTL_SECONDS must be >= 60. Got: ${env.STORAGE_MULTIPART_TTL_SECONDS}`,
    );
  }
  const defaultMaxObject = backend === 's3' ? 5 * ONE_TIB : 50 * ONE_GIB;
  const maxObjectSizeBytes = parsePositiveIntBytes(
    env.STORAGE_MAX_OBJECT_SIZE_BYTES,
    defaultMaxObject,
    'STORAGE_MAX_OBJECT_SIZE_BYTES',
    1,
    Number.MAX_SAFE_INTEGER,
  );

  if (maxObjectSizeBytes <= thresholdBytes) {
    throw new Error(
      `STORAGE_MAX_OBJECT_SIZE_BYTES (${maxObjectSizeBytes}) must be greater than ` +
        `STORAGE_MULTIPART_THRESHOLD_BYTES (${thresholdBytes}). Otherwise the multipart ` +
        `protocol is unreachable: every file large enough to trigger it overflows the ceiling.`,
    );
  }
  if (partSizeBytes * 10_000 < maxObjectSizeBytes) {
    throw new Error(
      `STORAGE_MULTIPART_PART_SIZE_BYTES (${partSizeBytes}) * 10000 = ${partSizeBytes * 10_000} ` +
        `is less than STORAGE_MAX_OBJECT_SIZE_BYTES (${maxObjectSizeBytes}). With this part size, ` +
        `the maximum object would require more than S3's 10000-part cap. Raise the part size or ` +
        `lower the max object size.`,
    );
  }

  return { thresholdBytes, partSizeBytes, ttlSeconds, maxObjectSizeBytes };
}

function resolveTicketSweepConfig(env: Env): TicketSweepConfig {
  // Reasonable upper bounds: a year of seconds caps the universe of sane
  // values. We're not trying to be clever, just catching pasted-wrong env
  // values like `60000000` for "minute" before they become a 23-day interval.
  const ONE_YEAR = 365 * 24 * 3600;

  const intervalSeconds = parsePositiveIntSeconds(
    env.TICKET_SWEEP_INTERVAL_SECONDS,
    60,
    'TICKET_SWEEP_INTERVAL_SECONDS',
    ONE_YEAR,
  );
  const pendingGraceSeconds = parsePositiveIntSeconds(
    env.TICKET_PENDING_GRACE_SECONDS,
    60,
    'TICKET_PENDING_GRACE_SECONDS',
    ONE_YEAR,
  );
  const retentionSeconds = parsePositiveIntSeconds(
    env.TICKET_RETENTION_SECONDS,
    7 * 24 * 3600,
    'TICKET_RETENTION_SECONDS',
    ONE_YEAR,
  );

  return { intervalSeconds, pendingGraceSeconds, retentionSeconds };
}

function parseLimit(
  env: Env,
  maxVar: string,
  windowVar: string,
  fallbackMax: number,
  fallbackWindowSeconds: number,
): WindowLimitConfig {
  return {
    max: parsePositiveIntSeconds(env[maxVar], fallbackMax, maxVar, 1_000_000),
    windowSeconds: parsePositiveIntSeconds(
      env[windowVar],
      fallbackWindowSeconds,
      windowVar,
      365 * 24 * 3600,
    ),
  };
}

function parseSourceList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveSecurityConfig(
  env: Env,
  nodeEnv: AppConfig['nodeEnv'],
  baseUrl: string,
): SecurityConfig {
  let baseUrlIsHttps = false;
  try {
    baseUrlIsHttps = new URL(baseUrl).protocol === 'https:';
  } catch {
    baseUrlIsHttps = false;
  }

  const headersEnabled = parseBool(env.SECURITY_HEADERS_ENABLED, nodeEnv === 'production');
  const hstsDefault = nodeEnv === 'production' && baseUrlIsHttps;

  return {
    trustProxyHeaders: parseBool(env.SECURITY_TRUST_PROXY_HEADERS, false),
    rateLimit: {
      enabled: parseBool(env.RATE_LIMIT_ENABLED, true),
      maxTrackedKeys: parsePositiveIntSeconds(
        env.RATE_LIMIT_MAX_TRACKED_KEYS,
        20_000,
        'RATE_LIMIT_MAX_TRACKED_KEYS',
        1_000_000,
      ),
      auth: parseLimit(env, 'RATE_LIMIT_AUTH_MAX', 'RATE_LIMIT_AUTH_WINDOW_SECONDS', 10, 300),
      setup: parseLimit(env, 'RATE_LIMIT_SETUP_MAX', 'RATE_LIMIT_SETUP_WINDOW_SECONDS', 5, 900),
      publicLink: parseLimit(
        env,
        'RATE_LIMIT_PUBLIC_LINK_MAX',
        'RATE_LIMIT_PUBLIC_LINK_WINDOW_SECONDS',
        8,
        300,
      ),
      publicTicket: parseLimit(
        env,
        'RATE_LIMIT_PUBLIC_TICKET_MAX',
        'RATE_LIMIT_PUBLIC_TICKET_WINDOW_SECONDS',
        60,
        60,
      ),
      publicPartUrls: parseLimit(
        env,
        'RATE_LIMIT_PUBLIC_PART_URL_MAX',
        'RATE_LIMIT_PUBLIC_PART_URL_WINDOW_SECONDS',
        120,
        60,
      ),
      publicConfirm: parseLimit(
        env,
        'RATE_LIMIT_PUBLIC_CONFIRM_MAX',
        'RATE_LIMIT_PUBLIC_CONFIRM_WINDOW_SECONDS',
        120,
        60,
      ),
    },
    headers: {
      enabled: headersEnabled,
      hstsEnabled: parseBool(env.SECURITY_HSTS_ENABLED, hstsDefault),
      hstsMaxAgeSeconds: parsePositiveIntSeconds(
        env.SECURITY_HSTS_MAX_AGE_SECONDS,
        15552000,
        'SECURITY_HSTS_MAX_AGE_SECONDS',
        2 * 365 * 24 * 3600,
      ),
      hstsIncludeSubDomains: parseBool(env.SECURITY_HSTS_INCLUDE_SUBDOMAINS, false),
      hstsPreload: parseBool(env.SECURITY_HSTS_PRELOAD, false),
      cspExtraConnectSrc: parseSourceList(env.SECURITY_CSP_EXTRA_CONNECT_SRC),
    },
  };
}
