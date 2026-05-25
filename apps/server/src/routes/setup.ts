import { Hono } from 'hono';

import type { AuthModule } from '../auth/index.js';

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
 * `POST /api/setup` accepts the very first user. It re-checks "no user
 * exists" inside the handler (independent of any UI gating), so the endpoint
 * is safe even if someone POSTs to it after setup is done — they get a 403.
 *
 * Once a user exists, both ways the route is "sealed": the GET still answers
 * but reports `{ needsSetup: false }`, and the POST 403s.
 */
export function createSetupRoute(authModule: AuthModule): Hono {
  const route = new Hono();

  route.get('/', (c) => {
    return c.json({ needsSetup: !authModule.hasAnyUser() });
  });

  route.post('/', async (c) => {
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
      await authModule.createAdmin({ username, password, name });
    } catch (err) {
      // Race condition: a parallel POST or env-seed beat us. Re-check and
      // return the appropriate signal.
      if (authModule.hasAnyUser()) {
        return c.json({ error: 'setup_already_complete' }, 403);
      }
      const message = err instanceof Error ? err.message : 'unknown_error';
      return c.json({ error: 'signup_failed', message }, 400);
    }

    return c.json({ ok: true });
  });

  return route;
}
