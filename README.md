<!-- prettier-ignore -->
<div align="center">

# ⚓ File Harbor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Node version](https://img.shields.io/badge/Node.js-%3E=20-3c873a?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=flat-square&logo=hono&logoColor=white)](https://hono.dev)
[![React](https://img.shields.io/badge/React-149eca?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![Drizzle](https://img.shields.io/badge/Drizzle-c5f74f?style=flat-square&logo=drizzle&logoColor=black)](https://orm.drizzle.team)
[![Docker](https://img.shields.io/badge/Docker-2496ed?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com)

Self-hosted file send/receive service — one container, one volume, no external bucket required.

[Overview](#overview) • [Quick start](#quick-start) • [Storage backends](#storage-backends) • [Configuration](#configuration) • [Troubleshooting](#troubleshooting) • [Local development](#local-development)

</div>

## Overview

File Harbor is a single-container service for sending files to people and receiving files from them via short, shareable URLs. The operator runs one Docker container, mounts one data volume, and shares short links that let other people upload or download.

Bytes go straight from the browser to storage via short-lived presigned URLs. File Harbor itself is a metadata + policy service: it issues upload/download tickets, enforces per-link password / expiry / quota, and verifies that uploads actually landed.

**Two storage modes:**

- **`local`** (default) — bytes live on the same data volume as the SQLite DB. No external dependencies, no CORS to configure. One container, one volume, working service.
- **`s3`** — bytes live in any S3-compatible bucket you already own (Cloudflare R2, MinIO, AWS S3, Backblaze B2). Useful when you want bytes off-host, want to scale beyond a single instance, or already have an S3-shaped place for them.

By design, v1 ships with one admin user, no public signup, and no team support.

### Features

- **Direct transfers, either backend.** Browsers `PUT` / `GET` straight to storage via short-lived presigned URLs. The service handles policy, not bytes.
- **Receive links** (`/r/<code>`) — let others upload to you, with optional label, password, max-uploads quota, and expiry.
- **Send links** (`/s/<code>`) — bundle one or more files into a download link with optional label, password, max-downloads quota, and expiry. Disable, re-enable, and delete from the dashboard.
- **One-time setup.** A browser wizard or a headless env-var seed creates the admin account. After that, the `/setup` route seals itself.
- **In-app notifications** when a file lands in a receive link.
- **Background sweep** of stale tickets — no admin tinkering required.
- **Pick your storage.** Local filesystem (default) or any S3-compatible bucket.
- **Boot-time validation.** Misconfiguration (missing secret, unwritable data volume, unreachable bucket, mismatched admin env) aborts startup loudly rather than silently degrading.
- **Migrations on every start.** SQLite + Drizzle, applied idempotently.

## Prerequisites

- **Docker** (or any OCI-compatible runtime).
- **A persistent data volume** (or host directory) to mount at `/data`. SQLite, uploaded bytes, and any future durable state live there.
- *(Optional, S3 mode only)* an S3-compatible bucket with `PutObject` / `GetObject` / `DeleteObject` / `HeadObject` credentials, CORS configured for your instance origin. See [Storage backends → S3 mode](#s3-mode).

## Quick start

### 1. Build the image

```bash
git clone https://github.com/thatjuan/fileharbor.git
cd fileharbor
docker build -t fileharbor .
```

### 2. Run the container

Generate two stable secrets once and keep them for the life of the deployment — regenerating on every restart invalidates all sessions and breaks any in-flight presigned URLs:

```bash
mkdir -p /srv/fileharbor
openssl rand -hex 32 > /srv/fileharbor/auth-secret
openssl rand -hex 32 > /srv/fileharbor/storage-secret
```

Then start the container:

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

That's it. No bucket, no CORS, no S3 keys. SQLite and uploaded bytes live under `/data`; the named volume `fileharbor-data` survives container replacement. Drizzle migrations run automatically on every start.

> [!TIP]
> Prefer a `.env` file? Copy [`.env.example`](./.env.example), fill it in, and use `--env-file .env` instead of the individual `-e` flags. The example shows both backends — local first, S3 second.

> [!NOTE]
> To use an external S3-compatible bucket instead, set `STORAGE_BACKEND=s3` and the `S3_*` vars. See [Storage backends → S3 mode](#s3-mode).

### 3. Create the admin account

There is one admin user, created one of two ways:

- **Browser wizard.** Open `https://files.example.com/setup` and submit username + password. After the user exists, the route seals itself — `POST /api/setup` returns 403 and the SPA bounces `/setup` to the dashboard. There is no public signup at any point.
- **Headless seed.** Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the environment. If both are set and no user exists at boot, File Harbor creates the admin during startup before HTTP starts accepting requests. Both values must be set together; setting only one aborts startup. After the user exists, the values are ignored.

### 4. Log in, create a link, share

Open `https://files.example.com/`, log in, then:

- **Receive a file from someone.** Create a *receive link* from the dashboard. Optionally set a label, password, max-uploads quota, and expiry. Copy the `https://files.example.com/r/<code>` URL and send it. The recipient opens it and uploads directly via a presigned `PUT`. You see the file appear in your dashboard.
- **Send a file to someone.** Create a *send link*, upload one or more files from your dashboard (also direct via presigned `PUT`), then copy the `https://files.example.com/s/<code>` URL. The recipient opens it and downloads directly via a presigned `GET`.

## Storage backends

File Harbor picks a storage backend at boot via `STORAGE_BACKEND`. The choice is global, not per-link.

| Aspect | `local` (default) | `s3` |
| --- | --- | --- |
| Where bytes live | On the data volume, alongside SQLite | In your S3-compatible bucket |
| External dependencies | None | A bucket + credentials |
| CORS | Not applicable | Required on the bucket |
| Operational complexity | Low — one container, one volume | Higher — two systems to monitor |
| Disk planning | Sized on your host | Offloaded to the bucket |
| Multi-host scaling | Not supported in v2 | Supported (multiple instances against one bucket) |
| Encryption-at-rest | Filesystem-level (LUKS, ZFS, ...) | Whatever the bucket provides |
| Object download via `Range` | Supported | Supported |
| Boot probe | Write-and-unlink in `LOCAL_OBJECTS_DIR` | `HeadBucket` against the configured bucket |

You can switch backends, but bytes do not migrate themselves — a switch is effectively a fresh start for storage. The SQLite DB still carries the old metadata; uploaded files that lived in the old backend will return 404 from the new one until you re-upload them.

### Local mode

Default. Activated when `STORAGE_BACKEND` is unset or `STORAGE_BACKEND=local`.

Reads:

- `LOCAL_OBJECTS_DIR` (optional, default `${DATA_DIR}/objects`) — directory holding object bytes. Created lazily; an unwritable directory aborts boot.
- `STORAGE_SIGNING_SECRET` (required in production; auto-generated and warned-once in development) — HMAC secret used to sign local presigned URLs. **Not** shared with `BETTER_AUTH_SECRET` on purpose: rotating one should not invalidate the other.

Presigned URLs in local mode point at File Harbor itself (`/api/storage/o/...`) and are HMAC-signed over the request method, key, expiry, and (when set) `Content-Type` / `Content-Length` / response-content-disposition. Possession of the URL is the authorization, same security model as an S3 SigV4 presigned URL. Mismatched headers or a leaked-then-expired URL → `403`.

The on-disk layout (`${LOCAL_OBJECTS_DIR}/<key>` with a sibling `<key>.meta.json` sidecar) is internal. It is not an S3 endpoint; nothing outside File Harbor should depend on the shape.

### S3 mode

Activated by `STORAGE_BACKEND=s3`. Requires `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_BUCKET` (`S3_REGION` defaults to `auto`; `S3_FORCE_PATH_STYLE` defaults to `false`). The bucket must already exist — File Harbor does not create buckets — and CORS must permit `PUT` and `GET` from your instance origin. A `HeadBucket` probe runs at boot and aborts startup on failure.

To swap into S3 mode, drop `STORAGE_BACKEND=s3` and the bucket vars into your env and restart:

```bash
docker run -d \
  --name fileharbor \
  -p 3000:3000 \
  -v fileharbor-data:/data \
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

The `STORAGE_SIGNING_SECRET` is not read in S3 mode — the bucket signs its own presigned URLs.

> [!IMPORTANT]
> If uploads fail with a CORS error in the browser console, the CORS rules on your bucket — not File Harbor itself — are almost always the cause. See [CORS recipes](#cors-recipes-s3-mode-only) below.

#### CORS recipes (S3 mode only)

> [!NOTE]
> This section only applies when `STORAGE_BACKEND=s3`. Local mode does not use CORS — uploads and downloads go to the same origin as the dashboard.

File Harbor's browser flows in S3 mode require the bucket to accept cross-origin `PUT` (uploads) and `GET` (downloads) from the public origin of your instance. The origin is the scheme + host + port of `BETTER_AUTH_URL`, e.g. `https://files.example.com`.

Required configuration, across providers:

- **Allowed origins:** the origin of `BETTER_AUTH_URL`. Add `http://localhost:5173` and `http://localhost:3000` too if you're testing the dev frontend against the bucket.
- **Allowed methods:** `PUT` and `GET`.
- **Allowed headers:** at minimum `Content-Type`. (Some providers also need `Content-Length`; AWS infers it.) Using `*` is the simplest and is fine for these buckets.
- **Exposed headers:** `ETag` (the browser SDK reads it from PUT responses).
- **Max age:** any reasonable preflight cache, e.g. `3600`.

Replace `https://files.example.com` in every snippet below with your `BETTER_AUTH_URL` origin.

##### Cloudflare R2

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

##### MinIO

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

##### AWS S3

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

## Configuration

Every config value is env-var-driven. The authoritative list lives in [`apps/server/src/config.ts`](./apps/server/src/config.ts); [`.env.example`](./.env.example) mirrors it with comments. Summary:

### Core runtime

| Variable       | Required | Default                                    | Purpose                                                                                                            |
| -------------- | -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `PORT`         | no       | `3000`                                     | HTTP port the Node process binds to.                                                                               |
| `NODE_ENV`     | no       | `development` (Docker image: `production`) | When `production`, the server also serves the built frontend.                                                      |
| `DATA_DIR`     | no       | `./data` (Docker image: `/data`)           | Directory for SQLite + (in local mode) object bytes + future durable state. Mount a volume here.                   |
| `DATABASE_URL` | no       | `${DATA_DIR}/fileharbor.db`                | Override the DB path. Accepts a raw path or a `file:` URL.                                                         |
| `WEB_DIST_DIR` | no       | `./web` (Docker image: `/app/web`)         | Absolute path to the built frontend the server serves in production. You normally don't need to set this.          |

### Auth

| Variable             | Required            | Default                    | Purpose                                                                                                                                   |
| -------------------- | ------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | yes (in production) | ephemeral per-process (dev) | Signs session cookies. Generate with `openssl rand -hex 32`. In dev, an ephemeral secret is auto-generated and sessions reset on restart. |
| `BETTER_AUTH_URL`    | recommended in prod | `http://localhost:${PORT}` | Public-facing base URL. Used for cookie host pinning and callback URLs. In S3 mode, its origin is what you grant in your bucket's CORS rules. |
| `ADMIN_USERNAME`     | no                  | unset                      | With `ADMIN_PASSWORD`, headless-seeds the admin on first boot. Setting only one of the two aborts startup.                                |
| `ADMIN_PASSWORD`     | no                  | unset                      | Pairs with `ADMIN_USERNAME`. Ignored once the admin user exists.                                                                          |

### Storage — backend selector

| Variable           | Required | Default | Purpose                                                                              |
| ------------------ | -------- | ------- | ------------------------------------------------------------------------------------ |
| `STORAGE_BACKEND`  | no       | `local` | `local` (default) stores bytes on the data volume. `s3` uses an external S3 bucket.  |

### Storage — local mode (only when `STORAGE_BACKEND=local`)

| Variable                       | Required            | Default                | Purpose                                                                                                       |
| ------------------------------ | ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `LOCAL_OBJECTS_DIR`            | no                  | `${DATA_DIR}/objects`  | Directory holding object bytes. Created if missing; write-and-unlink probe runs at boot.                      |
| `STORAGE_SIGNING_SECRET`       | yes (in production) | ephemeral per-process (dev) | HMAC secret signing local presigned URLs. Not shared with `BETTER_AUTH_SECRET`. Generate with `openssl rand -hex 32`. |
| `STORAGE_PRESIGN_TTL_SECONDS`  | no                  | `300`                  | TTL for local presigned URLs, in seconds. Max 604800 (7 days). Keep short.                                    |

### Storage — S3 mode (only when `STORAGE_BACKEND=s3`)

| Variable                 | Required | Default | Purpose                                                                                                            |
| ------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `S3_ENDPOINT`            | yes      | —       | Endpoint URL of the bucket service. Validated as a URL at boot.                                                    |
| `S3_REGION`              | no       | `auto`  | Required by the AWS SDK; `auto` is fine for R2 / MinIO. Set to your AWS region (e.g. `us-east-1`) for AWS S3.      |
| `S3_ACCESS_KEY_ID`       | yes      | —       | Access key.                                                                                                        |
| `S3_SECRET_ACCESS_KEY`   | yes      | —       | Secret key.                                                                                                        |
| `S3_BUCKET`              | yes      | —       | Bucket name. Must already exist; `HeadBucket` runs at boot and aborts startup on failure.                          |
| `S3_FORCE_PATH_STYLE`    | no       | `false` | `true` for MinIO and R2 setups that need path-style addressing. AWS S3 supports either; virtual-hosted is default. |
| `S3_PRESIGN_TTL_SECONDS` | no       | `300`   | TTL for presigned URLs. Max 604800 (7 days, SigV4 ceiling). Keep short — short URL lifetimes limit leak blast.     |

### Ticket cleanup sweep

A background job inside the Node process sweeps stale upload/download tickets.

| Variable                        | Required | Default            | Purpose                                                                |
| ------------------------------- | -------- | ------------------ | ---------------------------------------------------------------------- |
| `TICKET_SWEEP_INTERVAL_SECONDS` | no       | `60`               | How often the sweep wakes up.                                          |
| `TICKET_PENDING_GRACE_SECONDS`  | no       | `60`               | Buffer past presign TTL before a pending ticket is considered expired. |
| `TICKET_RETENTION_SECONDS`      | no       | `604800` (7 days)  | How long terminal tickets are kept before deletion.                    |

## Persistence

File Harbor keeps a single SQLite database under `DATA_DIR` (default `/data/fileharbor.db` in the container) for metadata — links, tickets, file records, the admin user, notifications. In **local mode** the same volume also holds object bytes under `${LOCAL_OBJECTS_DIR}` (default `${DATA_DIR}/objects`). In **S3 mode** the bytes live in your bucket and only metadata lives on the volume.

Mount `/data` to a named volume or host directory so container replacement preserves everything that lives there. The Docker image already declares `VOLUME ["/data"]`; you only need to bind it to something durable:

```bash
docker run -v fileharbor-data:/data ...
# or
docker run -v /srv/fileharbor:/data ...
```

> [!NOTE]
> In local mode, the data volume is the single point of failure for bytes — back it up. In S3 mode, losing the volume costs you link metadata but not file bytes (orphan objects remain in the bucket; you would need to re-create the links pointing at them). The Drizzle migration tooling re-applies migrations idempotently on every start, recorded in the `__drizzle_migrations` table.

## Upgrading

Stop the container, pull the new image, start it again with the same volume and env. Migrations run automatically.

```bash
docker pull fileharbor:latest   # once published; for now, rebuild from source
docker stop fileharbor && docker rm fileharbor
docker run -d --name fileharbor -p 3000:3000 -v fileharbor-data:/data --env-file .env fileharbor
```

There is no separate migration command to run by hand. The migrator records applied migrations inside the DB, so repeat starts are no-ops.

## Limitations of v1

> [!WARNING]
> By design, v1 does **not** include:
>
> - **Multi-user.** One admin only. No teams, no shared management, no roles.
> - **Public signup.** Disabled at the API level; `/setup` seals after the first user exists.
> - **Resumable / chunked uploads.** A single presigned `PUT` per file. Multipart is a likely v2.
> - **Multi-host scaling in local mode.** A multi-instance deploy in local mode would need shared storage (NFS/EFS) and shared HMAC secrets; that is a separate, opt-in deployment model. Use S3 mode for multi-host.
> - **End-to-end encryption.** Files are stored as-is in whichever backend you chose. Encryption-at-rest is your filesystem's job (local mode) or your bucket's job (S3 mode).
> - **Virus scanning, content moderation, file previews, thumbnails.**
> - **Folders.** A send link can bundle multiple files, but there's no hierarchy.
> - **Email / webhook notifications.** In-app notifications only in v1.
> - **Bandwidth or per-link rate limiting.**
> - **Audit log / detailed access history.**
> - **Bytes-migration tooling between backends.** Switching `STORAGE_BACKEND` is a fresh start for storage.

See the PRD's *Out of Scope* section in the GitHub issues for the complete list.

## Troubleshooting

### Container exits at startup with `STORAGE_SIGNING_SECRET is required`

In production with `STORAGE_BACKEND=local`, the secret signs local presigned URLs and is required. Generate one with `openssl rand -hex 32` and set it in the environment. In development the dev path auto-generates an ephemeral per-process secret with a warning.

### Container exits at startup with `S3_* is required when STORAGE_BACKEND=s3`

You opted into S3 mode but didn't supply the bucket credentials. Either set the missing variables, or unset `STORAGE_BACKEND` (the default is `local` and needs no `S3_*` vars).

### Container exits at startup with `Storage bootstrap failed: cannot write to LOCAL_OBJECTS_DIR`

The data volume isn't writable, or the mounted path doesn't exist where File Harbor expects. Check that `/data` (or whatever you set `DATA_DIR` to) is a writable volume from inside the container.

### Container exits at startup with an S3 / HeadBucket error

The boot probe calls `HeadBucket` against `S3_ENDPOINT/S3_BUCKET`. Failure aborts startup deliberately so misconfiguration is caught immediately. Verify:

- The bucket name exists and the credentials can read it.
- `S3_ENDPOINT` is reachable from inside the container (try `docker exec ... curl`).
- For MinIO and many R2 setups, `S3_FORCE_PATH_STYLE=true` is required.

### Upload fails in the browser with a CORS error (S3 mode)

Your bucket's CORS rules don't permit a `PUT` from the origin of `BETTER_AUTH_URL`. Check the browser console for the exact origin the request came from, then apply the matching recipe from [CORS recipes](#cors-recipes-s3-mode-only). The origin you grant must be an exact match — scheme, host, and port. Local mode never produces a CORS error because uploads and downloads go to the same origin as the dashboard.

### Presigned URLs work in the browser but not from inside the container, or vice versa (S3 mode)

The presigned URL is generated against `S3_ENDPOINT`. If you set `S3_ENDPOINT=http://minio:9000` (a docker-network hostname), browsers on the host can't resolve `minio`. Conversely, if you set `S3_ENDPOINT=http://localhost:9000`, the container can't reach `localhost`. Use a hostname that resolves from wherever the browser will load the page — usually a public DNS name or your LAN IP.

### `BETTER_AUTH_SECRET is required in production`

The server refuses to start in `NODE_ENV=production` without a stable secret. Generate one with `openssl rand -hex 32` and set it in the environment.

### `ADMIN_USERNAME and ADMIN_PASSWORD must be set together`

You set one and not the other. Set both, or neither (and use the `/setup` wizard).

### Sessions reset on every restart in development

Expected when `BETTER_AUTH_SECRET` is unset; the dev path auto-generates an ephemeral per-process secret. Set `BETTER_AUTH_SECRET` in `.env` to make sessions persist across restarts. The same pattern applies to `STORAGE_SIGNING_SECRET` in local mode: presigned URLs minted before a restart will fail verification afterwards if the secret was ephemeral.

## Local development

```bash
npm install
npm run dev
```

This starts:

- the Hono server on `http://localhost:3000` (API only in dev — no static serving),
- the Vite dev server on `http://localhost:5173` with `/api/*` proxied to the Hono server.

Open `http://localhost:5173`. The default storage backend is `local`, so no external bucket is needed — uploads land under `./data/objects`. Set `STORAGE_BACKEND=s3` and the `S3_*` vars in `.env` if you want to develop against a real bucket (MinIO in Docker is the simplest local option).

### Repository layout

```
apps/
  server/     Hono API + production-mode static file serving
  web/        React + Vite frontend
scripts/      Operator verification scripts (storage, sweep)
Dockerfile    Multi-stage build → single runtime image
```

The two workspaces share a root `package.json` (npm workspaces) and a shared `tsconfig.base.json`. They are independently buildable but always shipped together inside one container.

### Useful scripts

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Run server and web in parallel (watch mode).              |
| `npm run build`   | Build the web app, then the server.                       |
| `npm start`       | Start the production server (expects `npm run build` first). |
| `npm run lint`    | ESLint over the whole repo.                               |
| `npm run format`  | Prettier write.                                           |
| `npm run db:generate` | Generate a new Drizzle migration from the schema diff. |
