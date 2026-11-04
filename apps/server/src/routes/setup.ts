import { Hono } from 'hono';

import type { SecurityConfig } from '../config.js';
import { AdminExistsError, type AuthModule } from '../auth/index.js';
import { logServerError } from '../http/errors.js';
import { clientIpFor } from '../security/client-ip.js';
import { enforceRateLimit, type FixedWindowRateLimiter } from '../security/rate-limit.js';

interface SetupBody {
  username?: unknown;
  password?: unknown;
  name?: unknown;
}

/**
 * First-run setup endpoints.
 *
 * `GET /api/setup` is always reachable so the SPA can decide whether to
 * render `/setup` or punt to `/login`. It returns `{ needsSetup: boolean }`
 * — never sensitive data, never 404.
 *
 * `POST /api/setup` accepts the very first user. It only takes
 * `application/json` (415 otherwise), so a cross-site page cannot send a
 * no-preflight `text/plain` POST; `app.ts` also mounts the admin Origin guard
 * in front of it. Creation goes through `createFirstAdmin`, which serializes
 * the "no user exists" check with the insert, so concurrent POSTs (or a POST
 * racing env seeding) yield exactly one admin and a 403 for the rest.
 *
 * Once a user exists, both ways the route is "sealed": the GET still answers
 * but reports `{ needsSetup: false }`, and the POST 403s.
 */
export function createSetupRoute(
  authModule: AuthModule,
  security: SecurityConfig,
  limiter: FixedWindowRateLimiter,
): Hono {
  const route = new Hono();

  route.get('/', (c) => {
    return c.json({ needsSetup: !authModule.hasAnyUser() });
  });

  route.post('/', async (c) => {
    const ip = clientIpFor(c, security);
    const limited = enforceRateLimit(c, security, limiter, [
      { key: `setup:${ip}`, limit: security.rateLimit.setup },
    ]);
    if (limited) return limited;

    const contentType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return c.json({ error: 'unsupported_media_type' }, 415);
    }

    if (authModule.hasAnyUser()) {
      // Already set up. 403 (not 404) communicates "this route exists but is
      // closed", which makes the failure mode obvious during ops triage.
      return c.json({ error: 'setup_already_complete' }, 403);
    }

    let body: SetupBody;
    try {
      body = (await c.req.json()) as SetupBody;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const name =
      typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : username;

    if (username.length < 3 || username.length > 64) {
      return c.json(
        { error: 'invalid_username', message: 'Username must be 3–64 characters.' },
        400,
      );
    }
    if (password.length < 8) {
      return c.json(
        { error: 'invalid_password', message: 'Password must be at least 8 characters.' },
        400,
      );
    }

    // Defer to Better Auth's username plugin for hashing + row creation. We
    // mint an internal placeholder email — Better Auth still requires one,
    // and we don't surface it anywhere.
    try {
      await authModule.createFirstAdmin({ username, password, name });
    } catch (err) {
      // A parallel POST or env seeding created (or is creating) the admin.
      if (err instanceof AdminExistsError) {
        return c.json({ error: 'setup_already_complete' }, 403);
      }
      logServerError('setup.create_admin_failed', err, { username });
      return c.json({ error: 'signup_failed', message: 'Could not complete setup.' }, 400);
    }

    return c.json({ ok: true });
  });

  return route;
}
