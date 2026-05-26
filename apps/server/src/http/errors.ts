import type { Context } from 'hono';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'secret',
  'set-cookie',
  'sig',
  'token',
]);

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.has(lower) || lower.startsWith('x-amz-');
}

export function redactUrlSecrets(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (shouldRedactKey(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeLogContext(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactUrlSecrets(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeLogContext(v));

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (shouldRedactKey(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = sanitizeLogContext(entry);
    }
  }
  return out;
}

export function logServerError(
  scope: string,
  err: unknown,
  context?: Record<string, unknown>,
): void {
  console.error(`[${scope}]`, {
    ...(context ? { context: sanitizeLogContext(context) } : {}),
    err,
  });
}

export function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 500,
  code: string,
  message?: string,
): Response {
  const body = message ? { error: code, message } : { error: code };
  return c.json(body, status);
}

export function messageFromAllowedError(
  err: unknown,
  allowed: readonly string[],
  fallback: string,
): string {
  const message = err instanceof Error ? err.message : String(err);
  return allowed.includes(message) ? message : fallback;
}
