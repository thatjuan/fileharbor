# ⚓ File Harbor

Self-hosted file send/receive service. One container, one volume, no external bucket required.

## What it does

Short, shareable URLs to send files to people or receive files from them.

- **Receive links** (`/r/<code>`) — others upload to you. Optional label, password, max-uploads quota, expiry.
- **Send links** (`/s/<code>`) — bundle files into a download link. Same policy controls.
- Bytes go browser ↔ storage via short-lived presigned URLs. File Harbor handles policy, not bytes.
- One admin, no public signup, no teams.

**Storage modes:** `local` (default — bytes on the data volume) or `s3` (any S3-compatible bucket: R2, MinIO, AWS, B2).

## Quick start

```bash
git clone https://github.com/thatjuan/fileharbor.git
cd fileharbor
docker build -t fileharbor .
```

Generate stable secrets once (regenerating invalidates sessions + in-flight presigned URLs):

```bash
mkdir -p /srv/fileharbor
openssl rand -hex 32 > /srv/fileharbor/auth-secret
openssl rand -hex 32 > /srv/fileharbor/storage-secret
```

Run:

```bash
docker run -d \
  --name fileharbor \
  -p 3000:3000 \
  -v fileharbor-data:/data \
  -e BETTER_AUTH_SECRET="$(cat /srv/fileharbor/auth-secret)" \
  -e BETTER_AUTH_URL="https://files.example.com" \
  -e STORAGE_SIGNING_SECRET="$(cat /srv/fileharbor/storage-secret)" \
  fileharbor
```

Create the admin one of two ways:

- Open `https://files.example.com/setup` and submit a username + password. Route seals after first user.
- Or set `ADMIN_USERNAME` + `ADMIN_PASSWORD` in the env (both required, ignored after admin exists).

Log in, create a link, share the URL.

## S3 mode

```bash
docker run -d --name fileharbor -p 3000:3000 -v fileharbor-data:/data \
  -e BETTER_AUTH_SECRET="..." \
  -e BETTER_AUTH_URL="https://files.example.com" \
  -e STORAGE_BACKEND=s3 \
  -e S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com" \
  -e S3_ACCESS_KEY_ID="..." \
  -e S3_SECRET_ACCESS_KEY="..." \
  -e S3_BUCKET="fileharbor" \
  -e S3_FORCE_PATH_STYLE=true \
  fileharbor
```

Bucket must exist + CORS must allow `PUT` and `GET` from your `BETTER_AUTH_URL` origin, expose `ETag`. A `HeadBucket` probe runs at boot.

## Cloudflare Tunnel (optional)

Set `CLOUDFLARE_API_TOKEN` (scopes `Zone:DNS:Edit` + `Account:Cloudflare Tunnel:Edit`) and `CLOUDFLARE_TUNNEL_DOMAIN`. Drop the `-p 3000:3000` flag — `cftunn` provisions the tunnel + DNS at startup. `BETTER_AUTH_URL` auto-derives from the domain.

## Large files

Files above 100 MiB (configurable via `STORAGE_MULTIPART_THRESHOLD_BYTES`) auto-upload in 16 MiB parts with parallel PUTs + per-part retry + cancel. Both storage modes. Lifts the Cloudflare Free-plan 100 MB cap automatically.

## Config

Every value is env-driven. Authoritative list: [`apps/server/src/config.ts`](./apps/server/src/config.ts). Mirror with comments: [`.env.example`](./.env.example). Key vars:

| Variable                                            | Purpose                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                | Signs session cookies. Required in production.                         |
| `BETTER_AUTH_URL`                                   | Public base URL. Used for cookies + CORS origin.                       |
| `STORAGE_BACKEND`                                   | `local` (default) or `s3`.                                             |
| `STORAGE_SIGNING_SECRET`                            | HMAC for local presigned URLs. Required in production, local mode.     |
| `DATA_DIR`                                          | SQLite + (local mode) bytes. Default `/data` in the image.             |
| `S3_*`                                              | Endpoint, keys, bucket. Required when `STORAGE_BACKEND=s3`.            |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD`                 | Headless admin seed. Both or neither.                                  |
| `STORAGE_MULTIPART_THRESHOLD_BYTES`                 | Multipart cut-over. Default 100 MiB.                                   |
| `RATE_LIMIT_*`                                      | In-memory abuse limits for auth/setup/public ticket surfaces.          |
| `SECURITY_HEADERS_*`                                | Production security headers and HSTS controls.                         |
| `SECURITY_TRUST_PROXY_HEADERS`                      | Trust forwarded IP headers only behind a trusted proxy. Default false. |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_TUNNEL_DOMAIN` | Tunnel mode. Both or neither.                                          |

## Security notes

Production responses include baseline CSP, nosniff, referrer, and frame-deny
headers. HSTS is enabled automatically for HTTPS `BETTER_AUTH_URL` deployments
and can be disabled for unusual proxy setups.

Rate limits are in-memory and process-local, which matches the single-container
v1 deployment model. Multi-replica deployments should add shared rate limiting
at the reverse proxy or a future shared backend.

`npm audit` may continue to report a moderate Better Auth peer-tooling chain
through `drizzle-kit -> @esbuild-kit -> esbuild`. File Harbor does not execute
Drizzle Kit in the production server path; it is retained for schema generation
and Better Auth peer compatibility until upstream publishes a clean peer tree.

## Persistence

Mount `/data` to a named volume or host dir. SQLite + (local mode) object bytes live there. Drizzle migrations run on every start. Upgrade = pull image, restart, same volume.

## Local development

```bash
npm install
npm run dev
```

Hono API on `:3000`, Vite on `:5173` (proxies `/api/*` to Hono). Default `local` backend, bytes under `./data/objects`.
