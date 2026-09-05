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

/**
 * The host (hostname[:port]) the request actually arrived on, for a
 * same-origin CSRF check that survives reverse proxies and tunnels.
 *
 * Behind a proxy the operator opts into via `SECURITY_TRUST_PROXY_HEADERS`,
 * the public host is in `X-Forwarded-Host` (the `Host` header is usually
 * rewritten to the internal origin, e.g. `localhost:3000`). When proxy
 * headers are not trusted we use `Host` directly — a browser cannot forge
 * `Host` on a cross-site `fetch` (it's a forbidden header), so this stays a
 * sound same-origin signal.
 *
 * We compare by host only, not full origin: a TLS-terminating tunnel speaks
 * plain HTTP to the app, so the scheme seen here (`http`) won't match the
 * browser's `https` Origin. The host is the part that actually distinguishes
 * our site from an attacker's.
 *
 * Takes raw `Headers` rather than a Hono `Context` so Better Auth — which
 * only ever sees a Web `Request` — can share the same rule.
 */
export function requestSelfHost(headers: Headers, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    if (forwarded) return forwarded.toLowerCase();
  }
  const host = headers.get('host')?.trim();
  return host ? host.toLowerCase() : null;
}

/**
 * The same-origin allowance from {@link requestSelfHost}, expressed as full
 * origins for consumers that match on origin rather than host — Better Auth's
 * `trustedOrigins` in particular.
 *
 * Both schemes are returned because the scheme the browser used is not
 * recoverable behind a TLS-terminating tunnel. That is not a widening: the
 * host is identical either way, so a cross-site origin still never matches.
 */
export function selfTrustedOrigins(headers: Headers, trustProxy: boolean): string[] {
  const host = requestSelfHost(headers, trustProxy);
  return host ? [`https://${host}`, `http://${host}`] : [];
}

export function createAdminOriginGuard(config: AppConfig): MiddlewareHandler {
  const allowed = allowedAdminOrigins(config);
  const trustProxy = config.security.trustProxyHeaders;

  return async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const rawOrigin = c.req.header('origin');
    if (!rawOrigin || rawOrigin === 'null') {
      console.warn('[security] admin origin rejected: missing/null Origin', {
        method: c.req.method,
        path: c.req.path,
      });
      return c.json({ error: 'forbidden' }, 403);
    }

    let parsed: URL;
    try {
      parsed = new URL(rawOrigin);
    } catch {
      console.warn('[security] admin origin rejected: unparseable Origin', {
        method: c.req.method,
        path: c.req.path,
        rawOrigin,
      });
      return c.json({ error: 'forbidden' }, 403);
    }

    // Primary: the configured/dev allowlist.
    if (allowed.has(parsed.origin)) {
      await next();
      return;
    }

    // Fallback: same-origin as the host the request actually arrived on.
    // Covers proxied/tunnelled deploys where the public origin differs from
    // `config.auth.baseUrl`, without weakening CSRF protection — a cross-site
    // request's Origin won't match our serving host.
    const selfHost = requestSelfHost(c.req.raw.headers, trustProxy);
    if (selfHost && parsed.host.toLowerCase() === selfHost) {
      await next();
      return;
    }

    console.warn('[security] admin origin rejected', {
      method: c.req.method,
      path: c.req.path,
      origin: parsed.origin,
      allowed: [...allowed],
      trustProxy,
      host: c.req.header('host') ?? null,
      forwardedHost: c.req.header('x-forwarded-host') ?? null,
      forwardedProto: c.req.header('x-forwarded-proto') ?? null,
    });
    return c.json({ error: 'forbidden' }, 403);
  };
}
