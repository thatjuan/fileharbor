import type { MiddlewareHandler } from 'hono';

import type { AppConfig } from '../config.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function allowedAdminOrigins(config: AppConfig): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(config.auth.baseUrl).origin);
  } catch {
    // Config validation should make this unreachable; an empty allowlist fails closed.
  }
  if (config.nodeEnv !== 'production') {
    for (const origin of DEV_ORIGINS) origins.add(origin);
  }
  return origins;
}

export function createAdminOriginGuard(config: AppConfig): MiddlewareHandler {
  const allowed = allowedAdminOrigins(config);

  return async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const rawOrigin = c.req.header('origin');
    if (!rawOrigin || rawOrigin === 'null') {
      return c.json({ error: 'forbidden' }, 403);
    }

    let origin: string;
    try {
      origin = new URL(rawOrigin).origin;
    } catch {
      return c.json({ error: 'forbidden' }, 403);
    }

    if (!allowed.has(origin)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    await next();
  };
}
