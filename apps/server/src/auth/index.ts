import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { username as usernamePlugin } from 'better-auth/plugins';
import { count } from 'drizzle-orm';

import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { user } from '../db/schema.js';
import * as schema from '../db/schema.js';
import { selfTrustedOrigins } from '../security/origin.js';

/**
 * The Better Auth instance, plus the helpers that the rest of the codebase
 * needs: a session check, a "is the system already set up" probe, an admin
 * creator, and an env-driven seeder.
 *
 * The instance is constructed once at boot — passing `db` and `config` in
 * keeps the auth module free of `process.env` access (the project
 * convention).
 */
export interface AuthModule {
  /** The Better Auth instance. `handler` is the fetch handler we mount in Hono. */
  auth: ReturnType<typeof betterAuth>;
  /**
   * Cheap probe that returns `true` when at least one user row exists. Used
   * to gate the `/setup` route and to short-circuit env seeding.
   */
  hasAnyUser(): boolean;
  /**
   * Resolve the active session, if any, from a Web `Request`. Returns
   * `null` when unauthenticated or when the session/user lookup fails.
   */
  getSession(request: Request): Promise<SessionPayload | null>;
  /**
   * Create the first (and only) admin. Bypasses the `disableSignUp` gating
   * because it goes through Better Auth's internal adapter directly — this
   * is intentional: public sign-up is permanently disabled, but the operator
   * needs *some* path to bring the first user into existence.
   *
   * Throws if the username collides or any required field is invalid.
   * Callers must check `hasAnyUser()` first to enforce single-user mode.
   */
  createAdmin(input: AdminCreateInput): Promise<void>;
}

export interface SessionPayload {
  user: {
    id: string;
    name: string;
    email: string;
    username: string | null;
  };
}

export interface AdminCreateInput {
  username: string;
  password: string;
  name?: string;
}

export function createAuthModule(db: Db, config: AppConfig): AuthModule {
  const baseOptions: BetterAuthOptions = {
    appName: 'File Harbor',
    baseURL: config.auth.baseUrl,
    secret: config.auth.secret,
    // Better Auth rejects any mutating request whose Origin isn't trusted.
    // `baseURL`'s origin is always trusted implicitly; everything below is
    // additive.
    //
    // Resolved per request rather than as a static list so a proxied or
    // tunnelled deploy works when the public host differs from
    // `BETTER_AUTH_URL` — the same same-origin fallback our admin guard uses
    // (`selfTrustedOrigins`), so both boundaries agree on what "same site"
    // means. Without it, sign-out POSTs from the real host 403 (#67).
    //
    // The dev origins cover the Vite dev server on :5173, which proxies
    // `/api/*` here and so arrives with a different Origin than Host.
    trustedOrigins: (request) => [
      ...(request ? selfTrustedOrigins(request.headers, config.security.trustProxyHeaders) : []),
      ...(config.nodeEnv === 'production'
        ? []
        : ['http://localhost:5173', 'http://127.0.0.1:5173']),
    ],
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    // Single-user app: public sign-up is permanently disabled, on both the
    // email/password provider and the username plugin. The very first user
    // is created via the dedicated `/api/setup` flow (or env seeding), which
    // uses the auth context's internal adapter directly. Once that user
    // exists, no further sign-ups are possible — by API surface, not just
    // by policy.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    advanced: {
      // Cookies must be HTTPS-only in production. In dev we run plain HTTP
      // and the browser silently drops a `secure` cookie.
      useSecureCookies: config.nodeEnv === 'production',
      defaultCookieAttributes: {
        sameSite: 'lax',
      },
    },
    plugins: [
      usernamePlugin({
        minUsernameLength: 3,
        maxUsernameLength: 64,
      }),
    ],
  };

  const auth = betterAuth(baseOptions);

  // The two values that decide whether a mutating auth request is accepted.
  // Logged at boot so a misconfigured deploy (a 403 on sign-out) is diagnosable
  // from the container log alone.
  console.log(
    `[fileharbor] auth baseUrl=${config.auth.baseUrl} ` +
      `trustProxyHeaders=${config.security.trustProxyHeaders} ` +
      '(plus the request host as a same-origin fallback)',
  );

  const hasAnyUser = (): boolean => {
    const row = db.select({ value: count() }).from(user).get();
    return (row?.value ?? 0) > 0;
  };

  const getSession = async (request: Request): Promise<SessionPayload | null> => {
    try {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) return null;
      const u = session.user as {
        id: string;
        name: string;
        email: string;
        username?: string | null;
      };
      return {
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          username: u.username ?? null,
        },
      };
    } catch {
      return null;
    }
  };

  const createAdmin = async (input: AdminCreateInput): Promise<void> => {
    const ctx = await auth.$context;
    const usernameNormalized = input.username.toLowerCase();
    // Internal placeholder email so Better Auth's email-unique constraint
    // is satisfied. We never surface this address to the operator.
    const email = `${usernameNormalized}@local.fileharbor`;
    const passwordHash = await ctx.password.hash(input.password);
    const created = await ctx.internalAdapter.createUser({
      email,
      name: input.name?.trim() || input.username,
      emailVerified: true,
      username: usernameNormalized,
      displayUsername: input.username,
    });
    if (!created) {
      throw new Error('failed_to_create_user');
    }
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: 'credential',
      accountId: created.id,
      password: passwordHash,
    });
  };

  return { auth, hasAnyUser, getSession, createAdmin };
}

/**
 * Create the seed admin from `ADMIN_USERNAME`/`ADMIN_PASSWORD` when no user
 * exists yet. Idempotent: if a user is already present this is a no-op.
 */
export async function maybeSeedAdmin(authModule: AuthModule, config: AppConfig): Promise<void> {
  const seed = config.auth.adminSeed;
  if (!seed) return;
  if (authModule.hasAnyUser()) return;
  await authModule.createAdmin({ username: seed.username, password: seed.password });
  console.log(`[fileharbor] seeded admin user "${seed.username}" from environment.`);
}
