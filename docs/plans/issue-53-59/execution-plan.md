# Execution Plan: Issues #53-#59 Security Hardening

## Overview

This plan hardens File Harbor's public and admin HTTP boundary without changing
the product model. The implementation adds fail-closed multipart completion,
bounded rate limiting, admin mutation origin checks, production security
headers, generic client errors, safer multipart password transport, reproducible
Docker installs, and focused regression tests.

## Architecture / Approach

Keep the existing Hono + module-facade architecture. Add small reusable
security helpers under `apps/server/src/security/` and `apps/server/src/http/`,
wire them from `createApp`, and keep domain policy inside the existing ticket
and link modules. Avoid a new external rate-limit service for v1; use a bounded
in-memory limiter documented as single-process/self-hosted behavior.

## Execution Steps

### Phase 1: Test Harness and Config

1. Add server test scripts.
   - Root `package.json`: add `"test:server": "npm --workspace @fileharbor/server run test"`.
   - `apps/server/package.json`: add `"test": "node --test --import tsx \"src/**/*.test.ts\""`.
   - Use native `node:test` with existing `tsx`; do not add Vitest unless native tests prove insufficient.

2. Extend `apps/server/src/config.ts`.
   - Add `security: SecurityConfig` to `AppConfig`.
   - Include rate-limit settings, `trustProxyHeaders`, header settings, HSTS settings, and `cspExtraConnectSrc`.
   - Default `SECURITY_TRUST_PROXY_HEADERS=false`. Document that enabling it is safe only when Node is reachable exclusively through a trusted proxy.
   - Enable security headers by default in production.
   - Enable HSTS by default only when `NODE_ENV=production` and `BETTER_AUTH_URL` is HTTPS; allow `SECURITY_HSTS_ENABLED=false` to disable.
   - Document all new env vars in `.env.example` and summarize operator defaults in `README.md`.

### Phase 2: Shared HTTP Security Utilities

1. Add `apps/server/src/security/client-ip.ts`.
   - Resolve direct IP via `getConnInfo` from `@hono/node-server/conninfo`.
   - Use `cf-connecting-ip`, `x-real-ip`, or first `x-forwarded-for` only when `trustProxyHeaders` is true.
   - Fall back to `'unknown'` for test/runtime contexts without connection info.

2. Add `apps/server/src/security/rate-limit.ts`.
   - Implement a fixed-window limiter with lazy expiry and a hard maximum number of tracked keys.
   - Consume both coarse IP buckets and scoped buckets for public link/ticket endpoints.
   - Stable 429 shape: `{ "error": "rate_limited", "message": "Too many requests. Try again later." }`.
   - Set `Retry-After`.
   - Add unit tests for reset, key isolation, retry-after, and bounded cleanup.

3. Add `apps/server/src/security/origin.ts`.
   - Middleware checks only `POST`, `PATCH`, and `DELETE`; allow `GET`, `HEAD`, and `OPTIONS`.
   - Allowed origins: configured `BETTER_AUTH_URL` origin; in non-production also Vite dev origins.
   - Reject missing, `null`, malformed, or untrusted `Origin` with `403 { "error": "forbidden" }`.

4. Add `apps/server/src/http/errors.ts`.
   - Helpers for generic JSON errors, sanitized server logging, URL redaction, and allowed validation messages.
   - Redact password, token, secret, sig, `X-Amz-*`, authorization, cookie, and set-cookie values.
   - Never log request bodies or full request URLs.

5. Add `apps/server/src/http/security-headers.ts`.
   - Middleware sets headers after `await next()` so it covers API, Better Auth responses, local storage responses, and SPA/static responses.
   - CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' <storage sources> <extra sources>; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
   - Add `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
   - Add HSTS when enabled by config.
   - Test local backend, path-style S3/MinIO, virtual-hosted S3/R2 derivation, and explicit extra connect sources.

### Phase 3: App Wiring

1. In `apps/server/src/app.ts`, mount:
   - top-level security headers middleware immediately after `const app = new Hono()`;
   - global `app.onError` returning `500 { "error": "internal_error" }` while logging sanitized details;
   - auth sign-in rate limiter before `app.all('/api/auth/*', ...)` without reading the request body;
   - admin origin guard before admin routers with both exact and wildcard prefixes for `/receive-links`, `/send-links`, `/files`, and `/notifications`.

2. Do not apply the admin origin guard to `/api/public/*`, `/api/setup`, `/api/auth/*`, or `/api/storage/o/*`.

### Phase 4: Multipart Size Enforcement

1. In `apps/server/src/tickets/upload-tickets.ts`, change `completeMultipart`.
   - Keep existing pending-to-completing guarded transition.
   - If `storage.completeMultipart` throws, keep the current abort/pending-abort path.
   - After `storage.completeMultipart` succeeds, validate `headObject` fail-closed.
   - Treat missing object, `sizeHint === null`, `info.size !== sizeHint`, `info.size > maxObjectSizeBytes`, or `headObject` throw as failed completion.
   - Mark the ticket `failed`, never create a file row, and best-effort `storage.deleteObject(ticketRow.s3Key)`.
   - Do not enqueue `pending_aborts` after successful S3 assembly; abort no longer applies.
   - Log operator details: ticket id, key, upload id, expected size, actual size, max size, and failure kind.
   - Public response uses stable non-sensitive reason, preferably existing `storage_complete_failed`.

2. On success, ensure file row creation and ticket completion are transactionally consistent or guarded so a failed ticket update cannot leave a published file row.

3. Add `apps/server/src/tickets/upload-tickets.test.ts`.
   - Fake storage where `completeMultipart` succeeds and `headObject` returns a larger size.
   - Assert failed outcome, ticket status `failed`, no file row, and `deleteObject` called.
   - Assert local multipart behavior remains covered by existing local route/provider checks.

### Phase 5: Rate Limits and Password Transport

1. Rate-limit auth/setup/public endpoints.
   - Auth sign-in and setup POST: IP-scoped buckets.
   - Public receive/send password attempts: coarse IP bucket plus IP+code scoped bucket.
   - Public upload-ticket finalize, multipart init/parts/complete/abort, download-ticket mint/confirm: coarse IP bucket plus IP+ticket or IP+code scoped bucket where available.
   - Rate-limit responses must not disclose link existence, password correctness, or ticket validity.

2. Move multipart part-URL pagination password out of query strings.
   - In `apps/server/src/routes/public-upload-tickets.ts`, add `POST /:ticketId/upload/multipart/parts` with JSON `{ from, to, password? }`.
   - Keep old `GET /:ticketId/upload/multipart/parts?from=&to=` for unprotected compatibility only.
   - If old GET includes `password`, return `400 { "error": "password_in_query_not_allowed" }`.
   - Remove all server reads of plaintext password query params for this flow.
   - In `apps/web/src/lib/api.ts`, change `fetchMultipartPartUrls()` to POST JSON and never set `password` in `URLSearchParams`.

3. Tests:
   - setup limiter reaches 429;
   - public password attempt limiter reaches generic 429;
   - different link codes have isolated scoped buckets while sharing coarse bucket behavior;
   - POST part URLs passes body password to the module;
   - old GET rejects `?password=`.

### Phase 6: Generic Client Errors

1. Replace raw exception serialization while preserving useful validation.
   - `apps/server/src/routes/storage.ts`: PUT/PUT-PART 500 returns `{ "error": "write_failed" }`; DELETE 500 returns `{ "error": "delete_failed" }`.
   - `apps/server/src/routes/files.ts`: admin storage delete failure returns `{ "error": "storage_delete_failed" }`.
   - `apps/server/src/routes/setup.ts`: unexpected create-admin failure returns `{ "error": "signup_failed", "message": "Could not complete setup." }`.
   - `apps/server/src/routes/send-links.ts`: admin upload-ticket mint exception returns `{ "error": "mint_failed", "message": "Could not prepare file upload." }`.
   - For receive/send create/update validation catches, allowlist known domain validation codes and log unknown exceptions separately.

2. Tests assert thrown filesystem/adapter/SDK messages do not appear in client JSON while server logs retain redacted details.

### Phase 7: Security Headers

1. Add production response tests for representative API, Better Auth, local storage, SPA fallback, and static asset responses.
2. Build temporary production `webDistDir` fixtures in tests so `createApp` does not throw.
3. Verify CSP allows current frontend, local storage URLs, and S3 presigned upload/download origins.

### Phase 8: Dependencies and Docker

1. Update Vite to the lowest clean version supported by current plugin constraints.
   - Try `npm install vite@6.4.2 --workspace @fileharbor/web`.
   - Run `npm audit --json`; if Vite is still reported, move to the lowest clean supported Vite/plugin combination.

2. Do not downgrade `better-auth` to satisfy audit. It is core auth code and the suggested audit downgrade is not compatible with current Better Auth usage.

3. Update `Dockerfile`.
   - Require `package-lock.json`, not `package-lock.json*`.
   - Deps stage: `npm ci --workspaces --include-workspace-root`.
   - Runtime stage: copy root and workspace manifests needed by npm workspaces.
   - Runtime install: `npm ci --omit=dev --workspace @fileharbor/server --include-workspace-root`.
   - Do not use `--omit=peer` unless verified safe.

4. If Drizzle/Better Auth/esbuild audit findings remain, document them in the PR as upstream/dev-tooling or peer-surface findings only after verification.

## Verification

Run:

```bash
npm audit --omit=dev --json
npm audit --json
npm run lint
npm run test:server
npm run build
docker build .
git status --short
```

Expected:

- Vite audit finding resolved.
- Production audit clean or any remaining finding documented with non-production/upstream rationale.
- Docker builds use lockfile-enforcing `npm ci`.
- Tests cover multipart mismatch, rate limits, CSRF/origin, password transport, security headers, and generic errors.

## Risks

- In-memory rate limits are single-process and reset on restart; document this v1 deployment assumption.
- CSP can break S3 uploads if connect-src derivation is wrong; cover AWS, R2, MinIO/path-style tests.
- Strict admin origin checks can affect non-browser cookie-auth API clients; this is acceptable for admin mutations.
- S3 post-complete mismatch cleanup can fail to delete the already assembled object; the object remains unpublished because no file row exists, and logs provide operator cleanup details.
