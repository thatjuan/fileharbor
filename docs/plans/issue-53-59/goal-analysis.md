# Goal Analysis: Issues #53-#59 Security Hardening

## Scope

Implement one coordinated security-hardening PR for:

1. #53: Enforce multipart object-size limits in S3 storage.
2. #54: Add rate limiting to auth, setup, and public ticket endpoints.
3. #55: Stop sending link passwords in multipart part-URL query strings.
4. #56: Add CSRF/origin checks for admin mutations.
5. #57: Set production security headers for API and SPA responses.
6. #58: Return generic client errors while keeping detailed server logs.
7. #59: Clean dependency audit findings and use reproducible Docker installs.

These issues overlap in the same server boundary: Hono routes, upload-ticket
lifecycle, Better Auth mounting, public link policy checks, response headers,
error serialization, and Docker dependency installation. A single PR avoids
conflicting middleware and response-shape changes.

## Current Findings

- S3 multipart completion can assemble an object whose final size differs from
  the ticket `sizeHint`; the code logs the mismatch but still creates a file row.
- Local multipart already enforces per-part and final-byte totals and should
  remain unchanged except for generic 500 responses.
- Public multipart part URL pagination sends password through `?password=`.
- Admin routers rely on cookie auth but have no origin/CSRF guard.
- Better Auth, setup, and public ticket surfaces have no rate limits.
- Production Hono serves both API and SPA responses, so security headers belong
  in top-level app middleware.
- Several catch blocks serialize raw exception messages to clients.
- Docker uses `npm install` despite a committed lockfile.
- `npm audit` reports Vite/esbuild findings and Drizzle/Better Auth audit
  findings that require upgrade or documented upstream/tooling rationale.

## Execution Model

The implementation will be carried out by coding agents. Human time, speed,
and effort estimates do not apply. Prefer robust, testable, convention-aligned
changes over shortcuts. Do not introduce parallel patterns when existing route,
config, and script conventions fit.
