# Execution Plan: Fix 403 on file deletion / link revocation (Issue #62)

## Overview

DELETE `/api/files/:id` and revoke-link return 403 Forbidden because `auth.api.getSession` in Better Auth rejects requests whose Origin/Host don't match `trustedOrigins`. In production, `trustedOrigins` is set to `[config.auth.baseUrl]` only. When requests come through a proxy (Cloudflare Tunnel, reverse proxy), the Origin header may differ from the configured base URL, causing `auth.api.getSession` to throw a 403. The current `getSession` catch block swallows this throw and returns `null`, but the 403 is surfaced by the outer handler.

## Goals

1. Reproduce and verify the 403 occurs in the auth session lookup (not storage delete).
2. Fix `getSession` to propagate the 403 status from `auth.api.getSession`.
3. Improve `trustedOrigins` to handle proxied requests in production.
4. Add logging for the 403 case.
5. Verify deletion succeeds for both admin and receive-link delete paths.

## Architecture / Approach

Root cause is in the Better Auth `getSession` call, specifically the trusted-origins check. Fix:

1. **Improve `getSession` error handling** (the core fix)
   - Add `getSessionRaw` to `AuthModule` that returns the raw `Response | null` from `auth.api.getSession`.
   - Update `requireAdmin` to call `getSessionRaw` and short-circuit on 403, returning the actual error.
   - Keep `getSession` backward-compatible (returning null on 403).

2. **Improve `trustedOrigins` for proxied requests** (production fix)
   - In `createAuthModule`, dynamically extend `trustedOrigins` with `X-Forwarded-Host` and `X-Forwarded-Proto` values when present.
   - This fixes the case where the app is behind Cloudflare Tunnel or a reverse proxy.
   - Also add `X-Forwarded-Proto` (`https`) to allow `https` origins from proxied requests even when `config.auth.baseUrl` is `http`.

## Execution Steps

### Phase 1: Diagnosis and reproduction

#### Step 1.1: Add logging to getSession in auth/index.ts
- Modify the catch block in `getSession` to log the error details (status code, message, and stack).
- The log line should include: `{ err: string, code: string | null, stack: string }`.
- Add a `getSessionRaw` method to the AuthModule interface.
- `getSessionRaw` calls `auth.api.getSession({ headers: request.headers })` directly without try/catch.
- Return the raw Response object when the call succeeds.

#### Step 1.2: Verify the Origin header is the cause
- Start the dev server.
- Hit DELETE `/api/files/:id` with Origin = `http://other-origin`.
- Confirm the logged error shows a Better Auth origin mismatch.
- Repeat with the correct Origin.

### Phase 2: Fix getSession — propagate 403

#### Step 2.1: Update AuthModule interface in auth/index.ts
Add `getSessionRaw`:
```ts
export interface AuthModule {
  // ... existing methods ...
  /**
   * Return the raw session object from Better Auth, or null if no session.
   * Returns the original Response when a session exists so callers can
   * inspect the actual status code (e.g. 403 for origin mismatch).
   */
  getSessionRaw(request: Request): Promise<Response | null>;
}
```

Implement `getSessionRaw`:
```ts
const getSessionRaw = async (request: Request): Promise<Response | null> => {
  const response = await auth.api.getSession({ headers: request.headers });
  return response; // Response or null
};
```

#### Step 2.2: Update requireAdmin middleware (auth/middleware.ts)
Change `requireAdmin` to prefer `getSessionRaw` for accurate error propagation:
```ts
export function requireAdmin(authModule: AuthModule): MiddlewareHandler<AdminContext> {
  return async (c, next) => {
    const raw = await authModule.getSessionRaw(c.req.raw);
    if (raw === null) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (raw.status === 403) {
      const body = await raw.text().catch(() => '');
      console.error('[auth] getSession 403', { body });
      return new Response(JSON.stringify({ error: 'forbidden', message: body }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    const session = await authModule.getSession(c.req.raw);
    if (!session) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('session', session);
    await next();
  };
}
```

### Phase 3: Fix trustedOrigins for proxied requests

#### Step 3.1: Improve trustedOrigins in auth/index.ts
Update the `createAuthModule` function to expand `trustedOrigins` dynamically:

```ts
// Build base trusted origins list
const baseTrustedOrigins: string[] = [config.auth.baseUrl];

// If behind a proxy (X-Forwarded-* present), add the forwarded origin too
if (config.auth.baseUrl.startsWith('http')) {
  const forwardedProto = 'https';
  const forwardedHost = `https://${new URL(config.auth.baseUrl).hostname}`;
  baseTrustedOrigins.push(forwardedHost);
  // In dev, also add http localhost + forwarded HTTPS
  if (config.nodeEnv !== 'production') {
    baseTrustedOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }
}

const auth = betterAuth({
  // ...
  trustedOrigins: baseTrustedOrigins,
});
```

#### Step 3.2: Detect and trust proxy headers in the Hono middleware chain
Add a `setXForwardedHeaders` middleware to the server's middleware stack that reads `X-Forwarded-Host` and `X-Forwarded-Proto` from incoming requests and sets them on the request context so they're visible to `auth.api.getSession`.

### Phase 4: Verification and tests

#### Step 4.1: Add unit tests for requireAdmin 403 handling
Create tests in `auth/middleware.test.ts`:
- Test that `requireAdmin` returns 403 when `getSessionRaw` returns 403.
- Test that `requireAdmin` returns 401 when `getSessionRaw` returns null.
- Test that `requireAdmin` returns 200 (next) on successful session.
- Test with the updated `trustedOrigins` config.

#### Step 4.2: Add integration test for DELETE /files
- Create a file, verify DELETE succeeds.
- Simulate a 403-tripping origin in the request.
- Verify 403 is returned (not 401, not 500).

#### Step 4.3: Manual verification in dev and production profiles
- Start the dev server, hit DELETE `/api/files/:id` with browser Origin header.
- Start the server in production mode with `STORAGE_BACKEND=s3` (or `local`).
- Hit DELETE through a proxy that sets `X-Forwarded-*`.
- Verify the responses in each case.

## Integration Points

1. `auth/index.ts` — `AuthModule` interface and `createAuthModule`.
2. `auth/middleware.ts` — `requireAdmin` middleware.
3. `routes/files.ts` — DELETE route (uses `requireAdmin`).
4. `routes/receive-links.ts` — delete link (also uses `requireAdmin`).
5. `http/server.ts` (or `src/index.ts`) — middleware chain ordering.

## Quality Assurance

- Unit tests for all `requireAdmin` branches.
- Integration tests for the DELETE flow.
- Dev + production smoke tests.
- Logging confirms the 403 diagnosis.

## Risk Register

- **Risk**: Changing `requireAdmin` to call `getSessionRaw` may alter behavior for edge cases where `auth.api.getSession` succeeds but `getSession` (with catch) returns null.
  - **Mitigation**: `requireAdmin` falls back to `getSession` if `getSessionRaw` returns a non-403 Response.
- **Risk**: Expanding `trustedOrigins` may allow unintended origins in production.
  - **Mitigation**: Only add well-known proxy headers (`X-Forwarded-*`), not all origins.
- **Risk**: The `X-Forwarded-*` values may contain query parameters or paths.
  - **Mitigation**: Strip query parameters from the Host header when constructing the forwarded origin.
