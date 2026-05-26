import type { MiddlewareHandler } from 'hono';

import type { AppConfig, StorageConfig } from '../config.js';

function quoteSource(source: string): string {
  if (source.startsWith("'")) return source;
  return source;
}

export function deriveStorageConnectSources(storage: StorageConfig): string[] {
  if (storage.backend === 'local') return [];

  const sources = new Set<string>();
  let endpoint: URL;
  try {
    endpoint = new URL(storage.endpoint);
  } catch {
    return [];
  }

  sources.add(endpoint.origin);

  if (!storage.forcePathStyle && storage.bucket.length > 0) {
    const exactBucketHost = `${storage.bucket}.${endpoint.host}`;
    sources.add(`${endpoint.protocol}//${exactBucketHost}`);

    const hostname = endpoint.hostname;
    if (hostname.includes('.')) {
      sources.add(`${endpoint.protocol}//*.${hostname}`);
    }
  }

  return [...sources];
}

export function buildContentSecurityPolicy(config: AppConfig): string {
  const connectSources = [
    "'self'",
    ...deriveStorageConnectSources(config.storage),
    ...config.security.headers.cspExtraConnectSrc,
  ];

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': [...new Set(connectSources.map(quoteSource))],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

function hstsValue(config: AppConfig): string {
  const parts = [`max-age=${config.security.headers.hstsMaxAgeSeconds}`];
  if (config.security.headers.hstsIncludeSubDomains) parts.push('includeSubDomains');
  if (config.security.headers.hstsPreload) parts.push('preload');
  return parts.join('; ');
}

export function createSecurityHeadersMiddleware(config: AppConfig): MiddlewareHandler {
  const csp = buildContentSecurityPolicy(config);

  return async (c, next) => {
    await next();

    if (!config.security.headers.enabled) return;

    c.header('Content-Security-Policy', csp);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    if (config.security.headers.hstsEnabled) {
      c.header('Strict-Transport-Security', hstsValue(config));
    }
  };
}
