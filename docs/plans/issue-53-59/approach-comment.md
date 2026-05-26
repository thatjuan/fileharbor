## Implementation Approach

This PR will handle #53-#59 as one coordinated security-hardening batch because the changes share the same Hono app boundary and public/admin route surfaces. The implementation keeps the existing module shape and adds focused security helpers for rate limiting, origin checks, response headers, redacted logging, and generic error responses.

### Why this path

The most important behavioral fix is fail-closed multipart completion: after S3 assembles a multipart object, File Harbor will verify the final object size against the upload ticket before publishing a file row. Rate limiting and CSRF/origin checks are implemented at route middleware boundaries so public unauthenticated flows remain available while admin cookie-auth mutations gain browser-origin protection. Docker moves to `npm ci` to match the committed lockfile.

### Scope

- Files to modify: `apps/server/src/app.ts`, `apps/server/src/config.ts`, server route files, `apps/server/src/tickets/upload-tickets.ts`, `apps/web/src/lib/api.ts`, `Dockerfile`, `package.json`, `apps/server/package.json`, `apps/web/package.json`, `package-lock.json`, `.env.example`, `README.md`.
- Files to create: security/http helper modules under `apps/server/src/security/` and `apps/server/src/http/`, plus focused server tests.
- Migrations: none expected.

### Steps

1. Add native Node server test scripts and focused tests for multipart size mismatch, rate limits, CSRF/origin checks, security headers, password transport, and generic errors.
2. Extend runtime config with bounded rate-limit settings, proxy-header trust, production header settings, HSTS controls, and CSP extra connect sources.
3. Add client-IP, bounded fixed-window rate limiting, admin origin guard, security header middleware, and redacted error/log helpers.
4. Wire middleware in `createApp` before the relevant route mounts without consuming Better Auth request bodies.
5. Enforce S3 multipart final object size after successful complete and before file-row publication; on mismatch, mark failed and best-effort delete the assembled object.
6. Change public multipart part-URL pagination to POST JSON for passwords; reject legacy GET requests that still include `?password=`.
7. Replace raw exception messages in storage, setup, and admin file/upload failures with stable generic JSON while preserving detailed redacted server logs.
8. Update Vite to the lowest audit-clean compatible version, change Docker installs to `npm ci`, and document any verified remaining non-runtime/upstream audit findings.

### Out of scope

- Distributed/shared rate limiting for multi-replica deployments.
- Replacing Better Auth or changing the single-admin auth model.
- Removing inline styles from the frontend to make CSP stricter than the current UI allows.

### Verification

- `npm audit --omit=dev --json`
- `npm audit --json`
- `npm run lint`
- `npm run test:server`
- `npm run build`
- `docker build .`

---

_Posted by an AI coding agent. The PR will reference this comment._
