# Fix: 403 on file deletion / link revocation (Issue #62)

## Root cause

DELETE `/api/files/:id`, DELETE `/api/receive-links/:id`, and the other
mutating admin routes returned `403 { "error": "forbidden" }` from the
**admin origin guard** (`apps/server/src/security/origin.ts`), not from
auth.

The guard runs ahead of `requireAdmin` (`apps/server/src/app.ts`) on every
`POST`/`PATCH`/`DELETE` under `/api/{receive-links,send-links,files,notifications}`.
It compares the browser `Origin` header against an allowlist that, in
production, contains only `new URL(config.auth.baseUrl).origin`. When the app
is served through a reverse proxy or Cloudflare Tunnel, the public origin the
browser sends (`https://files.example.com`) can differ from the configured
`config.auth.baseUrl`, so the guard rejects the request with a 403 before the
session is ever checked.

### Why the earlier diagnosis was wrong

An earlier draft of this plan blamed `auth.api.getSession` throwing a 403 on a
trusted-origins mismatch. That path cannot produce the observed 403:
`getSession` wraps the call in `try/catch` and returns `null` on any error, so
the failure surfaces as **401 `unauthorized`** from `requireAdmin`, never 403.
The only source of a 403 on the admin mutation path is the origin guard. The
tell is the response body: `{"error":"forbidden"}` (origin guard) vs
`{"error":"unauthorized"}` (auth).

## Fix (shipped)

`apps/server/src/security/origin.ts` — `createAdminOriginGuard`:

1. **Diagnostic logging.** Every rejection logs `console.warn('[security] admin
   origin rejected', { method, path, origin, allowed, trustProxy, host,
   forwardedHost, forwardedProto })`, so a misconfigured deploy names the exact
   mismatch instead of returning an opaque 403.

2. **Proxy-aware same-origin fallback.** When the `Origin` isn't in the
   configured allowlist, the guard also accepts the request if `Origin` matches
   the host the request actually arrived on:
   - `SECURITY_TRUST_PROXY_HEADERS=true` → the public host is taken from
     `X-Forwarded-Host` (the `Host` header is usually rewritten to the internal
     origin behind a proxy).
   - otherwise → the `Host` header is used. A browser cannot set `Host` on a
     cross-site `fetch` (it's a forbidden header), so this remains a sound
     same-origin / CSRF check.
   - Comparison is by **host**, not full origin: a TLS-terminating tunnel
     speaks plain HTTP to the app, so the locally observed scheme (`http`)
     would falsely mismatch the browser's `https` Origin.

This keeps CSRF protection intact — a genuine cross-site request's `Origin`
won't equal the serving host, and forged `X-Forwarded-*` is only honoured when
the operator has explicitly opted into trusting proxy headers.

## Operator note

Behind a reverse proxy or Cloudflare Tunnel, set:

```
SECURITY_TRUST_PROXY_HEADERS=true
```

Without it the forwarded-host fallback stays off (correct — untrusted forwarded
headers are spoofable). Alternatively, set `BETTER_AUTH_URL` to the exact public
origin so the configured allowlist matches directly.

## Tests

`apps/server/src/security/http-boundary.test.ts`:

- Configured origin accepted; cross-origin mutation rejected (existing).
- Same-origin via `X-Forwarded-Host` accepted when proxy headers trusted.
- `X-Forwarded-Host` ignored when proxy headers untrusted (anti-spoof).
- Same-origin via `Host` accepted without a proxy.

## Touched files

1. `apps/server/src/security/origin.ts` — guard logic + logging.
2. `apps/server/src/security/http-boundary.test.ts` — guard coverage.
