# File Harbor

File Harbor is a self-hosted file send/receive service. The operator runs a single Docker container, points it at any S3-compatible bucket they already own (Cloudflare R2, MinIO, AWS S3, Backblaze B2), and shares short URLs that let other people upload to them or download from them. **File bytes never traverse File Harbor.** Every transfer is a presigned URL straight between the browser and the bucket; File Harbor is a metadata + policy service that issues short-lived upload/download tickets, enforces per-link password/expiry/quota, and verifies via `HEAD` that uploads actually landed. There is no bundled storage; you bring the bucket. There is one admin user, no public signup, no team support — by design.

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [CORS recipes](#cors-recipes)
- [Persistence](#persistence)
- [Upgrading](#upgrading)
- [Limitations of v1](#limitations-of-v1)
- [Troubleshooting](#troubleshooting)
- [Local development](#local-development)
- [Contributing](#contributing)
- [License](#license)

## Prerequisites

- **Docker** (or any OCI-compatible runtime).
- **An S3-compatible bucket** with credentials that can `PutObject`, `GetObject`, `DeleteObject`, and `HeadObject` on it. Cloudflare R2, MinIO, AWS S3, and Backblaze B2 all work. The bucket must already exist — File Harbor does not create buckets.
- **CORS configured** on that bucket to allow `PUT` and `GET` from the origin you will run File Harbor on. See [CORS recipes](#cors-recipes) below.

## Quick start

### 1. Build the image (or pull, once published)

```bash
git clone https://github.com/thatjuan/fileharbor.git
cd fileharbor
docker build -t fileharbor .
```

### 2. Run the container

Generate a stable session secret once and keep it for the life of the deployment — regenerating it on every restart invalidates all sessions:

```bash
openssl rand -hex 32 > /srv/fileharbor/auth-secret
```

Then start the container. Substitute your bucket credentials and your instance's public URL:

```bash
docker run -d \
  --name fileharbor \
  -p 3000:3000 \
  -v fileharbor-data:/data \
  -e BETTER_AUTH_SECRET="$(cat /srv/fileharbor/auth-secret)" \
  -e BETTER_AUTH_URL="https://files.example.com" \
  -e S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com" \
  -e S3_ACCESS_KEY_ID="..." \
  -e S3_SECRET_ACCESS_KEY="..." \
  -e S3_BUCKET="fileharbor" \
  -e S3_FORCE_PATH_STYLE=true \
  fileharbor
```

Or, if you prefer a `.env` file, copy `.env.example` to `.env`, fill it in, and use `--env-file .env` instead of the individual `-e` flags.

The container binds port 3000. SQLite and any future durable state live under the `/data` volume; the named volume `fileharbor-data` above (or a host bind-mount) survives container replacement. Drizzle migrations run automatically on every start.

The full set of env vars is documented in [`.env.example`](./.env.example) and summarised in [Configuration](#configuration).

### 3. Create the admin account

There is one admin user. You create it in one of two ways:

- **Browser wizard.** Open `https://files.example.com/setup` and submit username + password. After the user exists, the route seals itself; `POST /api/setup` returns 403 and the SPA bounces `/setup` to the dashboard. There is no public signup at any point.
- **Headless seed.** Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the environment. If both are set and no user exists at boot, File Harbor creates the admin during startup before HTTP starts accepting requests. After the user exists, the values are ignored.

### 4. Log in, create a link, share

Open `https://files.example.com/`, log in, then:

- **Receive a file from someone.** Create a *receive link* from the dashboard. Optionally set a label, password, max-uploads quota, and expiry. Copy the `https://files.example.com/r/<code>` URL and send it. The recipient opens it, uploads directly to your bucket via a presigned PUT. You see the file appear in your dashboard.
- **Send a file to someone.** Create a *send link*. Upload the file (or several) from your dashboard — this also goes direct-to-bucket via a presigned PUT. Optionally set a label, password, max-downloads quota, and expiry. Copy the `https://files.example.com/s/<code>` URL and send it. The recipient opens it and downloads directly from your bucket via a presigned GET.

If uploads fail with a CORS error in the browser console, jump to [CORS recipes](#cors-recipes).

## Configuration

Every config value is env-var-driven. The authoritative list lives in `apps/server/src/config.ts`; [`.env.example`](./.env.example) mirrors it with comments. Summary:

### Core runtime

| Variable       | Required           | Default                                  | Purpose                                                                                                                            |
| -------------- | ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`         | no                 | `3000`                                   | HTTP port the Node process binds to.                                                                                               |
| `NODE_ENV`     | no                 | `development` (Docker image: `production`) | When `production`, the server also serves the built frontend.                                                                      |
| `DATA_DIR`     | no                 | `./data` (Docker image: `/data`)         | Directory for SQLite + future durable state. Mount a volume here.                                                                  |
| `DATABASE_URL` | no                 | `${DATA_DIR}/fileharbor.db`              | Override the DB path. Accepts a raw path or a `file:` URL.                                                                         |
| `WEB_DIST_DIR` | no                 | `./web` (Docker image: `/app/web`)       | Absolute path to the built frontend the server serves in production. You normally don't need to set this.                          |

### Auth

| Variable              | Required             | Default                       | Purpose                                                                                                                                                 |
| --------------------- | -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`  | yes (in production)  | ephemeral per-process (dev)   | Signs session cookies. Generate with `openssl rand -hex 32`. In dev, an ephemeral secret is auto-generated and sessions reset on restart.               |
| `BETTER_AUTH_URL`     | recommended in prod  | `http://localhost:${PORT}`    | Public-facing base URL. Used for cookie host pinning and callback URLs. **Its origin is what you grant in your bucket's CORS rules.**                   |
| `ADMIN_USERNAME`      | no                   | unset                         | With `ADMIN_PASSWORD`, headless seeds the admin on first boot. Setting only one of the two aborts startup.                                              |
| `ADMIN_PASSWORD`      | no                   | unset                         | Pairs with `ADMIN_USERNAME`. Ignored once the admin user exists.                                                                                        |

### Storage (S3-compatible)

| Variable                 | Required | Default | Purpose                                                                                                            |
| ------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `S3_ENDPOINT`            | yes      | —       | Endpoint URL of the bucket service. Validated as a URL at boot.                                                    |
| `S3_REGION`              | no       | `auto`  | Required by the AWS SDK; `auto` is fine for R2/MinIO. Set to your AWS region (e.g. `us-east-1`) for AWS S3.        |
| `S3_ACCESS_KEY_ID`       | yes      | —       | Access key.                                                                                                        |
| `S3_SECRET_ACCESS_KEY`   | yes      | —       | Secret key.                                                                                                        |
| `S3_BUCKET`              | yes      | —       | Bucket name. Must already exist; `HeadBucket` runs at boot and aborts startup on failure.                          |
| `S3_FORCE_PATH_STYLE`    | no       | `false` | `true` for MinIO and R2 setups that need path-style addressing. AWS S3 supports either; virtual-hosted is default. |
| `S3_PRESIGN_TTL_SECONDS` | no       | `300`   | TTL for presigned URLs. Max 604800 (7 days, SigV4 ceiling). Keep short — short URL lifetimes limit leak blast.     |

### Ticket cleanup sweep

A background job inside the Node process sweeps stale upload/download tickets.

| Variable                        | Required | Default            | Purpose                                                                                          |
| ------------------------------- | -------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `TICKET_SWEEP_INTERVAL_SECONDS` | no       | `60`               | How often the sweep wakes up.                                                                    |
| `TICKET_PENDING_GRACE_SECONDS`  | no       | `60`               | Buffer past presign TTL before a pending ticket is considered expired.                           |
| `TICKET_RETENTION_SECONDS`      | no       | `604800` (7 days)  | How long terminal tickets (expired/failed/completed) are kept before deletion.                   |

## CORS recipes

File Harbor's browser flows require the bucket to accept cross-origin `PUT` (uploads) and `GET` (downloads) from the public origin of your instance. The origin is the scheme+host+port of `BETTER_AUTH_URL`, e.g. `https://files.example.com`.

Required configuration, across providers:

- **Allowed origins:** the origin of `BETTER_AUTH_URL`. Add `http://localhost:5173` and `http://localhost:3000` too if you're testing the dev frontend against the bucket.
- **Allowed methods:** `PUT` and `GET`.
- **Allowed headers:** at minimum `Content-Type`. (Some providers also need `Content-Length`; AWS infers it.) Using `*` is the simplest and is fine for these buckets.
- **Exposed headers:** `ETag` (the browser SDK reads it from PUT responses).
- **Max age:** any reasonable preflight cache, e.g. `3600`.

Replace `https://files.example.com` in every snippet below with your `BETTER_AUTH_URL` origin.

### Cloudflare R2

Save as `cors.json`:

```json
[
  {
    "AllowedOrigins": ["https://files.example.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Apply via `wrangler`:

```bash
wrangler r2 bucket cors set fileharbor --file cors.json
```

Or apply via the AWS CLI pointed at the R2 endpoint (R2 implements the S3 API):

```bash
aws s3api put-bucket-cors \
  --endpoint-url "https://<account-id>.r2.cloudflarestorage.com" \
  --bucket fileharbor \
  --cors-configuration '{
    "CORSRules": [
      {
        "AllowedOrigins": ["https://files.example.com"],
        "AllowedMethods": ["PUT", "GET"],
        "AllowedHeaders": ["*"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3600
      }
    ]
  }'
```

You can also paste the JSON in the dashboard at *R2 → your bucket → Settings → CORS Policy*.

### MinIO

MinIO 2024+ supports per-bucket CORS via the S3 API. Save as `cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://files.example.com"],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Apply via the AWS CLI pointed at your MinIO endpoint:

```bash
aws s3api put-bucket-cors \
  --endpoint-url "http://minio.example.com:9000" \
  --bucket fileharbor \
  --cors-configuration file://cors.json
```

If your MinIO build is older and does not support `put-bucket-cors`, configure CORS on the MinIO server itself via `MINIO_API_CORS_ALLOW_ORIGIN` (a comma-separated list of origins) in its environment, then restart MinIO:

```bash
MINIO_API_CORS_ALLOW_ORIGIN="https://files.example.com" minio server /data
```

This is server-wide rather than per-bucket. For local development with MinIO in Docker, this env var is usually the lowest-friction option.

### AWS S3

Save as `cors.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://files.example.com"],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Apply:

```bash
aws s3api put-bucket-cors \
  --bucket fileharbor \
  --cors-configuration file://cors.json
```

Verify:

```bash
aws s3api get-bucket-cors --bucket fileharbor
```

You can also paste this in the AWS console at *S3 → your bucket → Permissions → Cross-origin resource sharing (CORS)*.

## Persistence

File Harbor keeps a single SQLite database under `DATA_DIR` (default `/data/fileharbor.db` in the container). This is metadata only — links, tickets, file records, the admin user, notifications. **File contents live in your bucket, not in this volume.**

Mount `/data` to a named volume or host directory so that container replacement preserves links, tickets, and the admin account. The Docker image already declares `VOLUME ["/data"]`; you only need to bind it to something durable:

```bash
docker run -v fileharbor-data:/data ...
# or
docker run -v /srv/fileharbor:/data ...
```

If you lose the volume, you lose your link metadata but not your files (they remain orphan objects in the bucket). The Drizzle migration tooling re-applies migrations idempotently on every start, recorded in the `__drizzle_migrations` table.

## Upgrading

Stop the container, pull the new image, start it again with the same volume and env. Migrations run automatically.

```bash
docker pull fileharbor:latest   # once published; for now, rebuild from source
docker stop fileharbor && docker rm fileharbor
docker run -d --name fileharbor -p 3000:3000 -v fileharbor-data:/data --env-file .env fileharbor
```

There is no separate migration command to run by hand. The migrator records applied migrations inside the DB, so repeat starts are no-ops.

## Limitations of v1

By design, v1 does not include:

- **Multi-user.** One admin only. No teams, no sharing of management, no roles.
- **Public signup.** Disabled at the API level; the `/setup` route seals after the first user exists.
- **Proxying.** File bytes never traverse File Harbor — the trade-off is that the bucket needs CORS, and the browser does the heavy lifting directly against the bucket.
- **Resumable / chunked uploads.** A single presigned PUT per file. Multipart is a likely v2.
- **End-to-end encryption.** Files are stored in the bucket as-is.
- **Virus scanning, content moderation, file previews, thumbnails.**
- **Folders.** A send link can bundle multiple files, but there's no hierarchy.
- **Email / webhook notifications.** In-app notifications only in v1.
- **Bandwidth or per-link rate limiting.**
- **Audit log / detailed access history.**

See the PRD's *Out of Scope* section in the GitHub issues for the complete list.

## Troubleshooting

### Upload fails in the browser with a CORS error

Your bucket's CORS rules don't permit a `PUT` from the origin of `BETTER_AUTH_URL`. Check the browser console for the exact origin the request came from, then apply the matching recipe from [CORS recipes](#cors-recipes). The origin you grant must be an exact match — scheme, host, and port.

### Presigned URLs work in the browser but not from inside the container, or vice versa

The presigned URL is generated against `S3_ENDPOINT`. If you set `S3_ENDPOINT=http://minio:9000` (a docker-network hostname), browsers on the host can't resolve `minio`. Conversely, if you set `S3_ENDPOINT=http://localhost:9000`, the container can't reach `localhost`. Use a hostname that resolves from wherever the browser will load the page — usually a public DNS name or your LAN IP.

### Container exits at startup with an S3 / HeadBucket error

The boot probe calls `HeadBucket` against `S3_ENDPOINT/S3_BUCKET`. Failure aborts startup deliberately so misconfiguration is caught immediately. Verify:

- The bucket name exists and the credentials can read it.
- `S3_ENDPOINT` is reachable from inside the container (try `docker exec ... curl`).
- For MinIO and many R2 setups, `S3_FORCE_PATH_STYLE=true` is required.

### `BETTER_AUTH_SECRET is required in production`

The server refuses to start in `NODE_ENV=production` without a stable secret. Generate one with `openssl rand -hex 32` and set it in the environment.

### `ADMIN_USERNAME and ADMIN_PASSWORD must be set together`

You set one and not the other. Set both, or neither (and use the `/setup` wizard).

### Sessions reset on every restart in development

Expected when `BETTER_AUTH_SECRET` is unset; the dev path auto-generates an ephemeral per-process secret. Set `BETTER_AUTH_SECRET` in `.env` to make sessions persist across restarts.

## Local development

```bash
npm install
npm run dev
```

This starts:

- the Hono server on `http://localhost:3000` (API only in dev — no static serving),
- the Vite dev server on `http://localhost:5173` with `/api/*` proxied to the Hono server.

Open `http://localhost:5173`. You still need a real S3-compatible bucket for storage; MinIO in Docker is the simplest local option.

### Repository layout

```
apps/
  server/     Hono API + production-mode static file serving
  web/        React + Vite frontend
Dockerfile    Multi-stage build → single runtime image
```

The two workspaces share a root `package.json` (npm workspaces) and a shared `tsconfig.base.json`. They are independently buildable but always shipped together inside one container.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for how PRDs and execution issues work.

## License

MIT. See [`LICENSE`](./LICENSE).
