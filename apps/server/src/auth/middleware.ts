import type { MiddlewareHandler } from 'hono';

import type { AuthModule, SessionPayload } from './index.js';

/**
 * Hono middleware that gates a route behind a valid Better Auth session.
 *
 * On hit: attaches the session payload to context under the `session` key.
 * On miss: short-circuits with a 401 (`{ error: 'unauthorized' }`).
 *
 * Single-user app: every authenticated user is "the admin", so the middleware
 * doesn't need to check roles. When/if v2 introduces multiple users, this is
 * the single place to add a role gate.
 */
export interface AdminContext {
  Variables: {
    session: SessionPayload;
  };
}

export function requireAdmin(authModule: AuthModule): MiddlewareHandler<AdminContext> {
  return async (c, next) => {
    const session = await authModule.getSession(c.req.raw);
    if (!session) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('session', session);
    await next();
  };
}
