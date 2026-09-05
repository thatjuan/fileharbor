<div align="center">

# ⚓ File Harbor

**Self-hosted file send/receive. One container, one volume.**

Short, shareable URLs to send files to people — or receive files from them. <br/>
Per-link policy, presigned uploads, optional Cloudflare Tunnel. No bucket required.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Self-hosted](https://img.shields.io/badge/Self--hosted-yes-success)](#scenario-1-local-storage-no-s3)
[![GitHub stars](https://img.shields.io/github/stars/thatjuan/fileharbor?style=social)](https://github.com/thatjuan/fileharbor/stargazers)

[Quick start](#build-the-image) ·
[Local mode](#scenario-1-local-storage-no-s3) ·
[S3 mode](#scenario-2-external-s3) ·
[Cloudflare Tunnel](#scenario-3-add-a-cloudflare-tunnel) ·
[Config](#config-reference)

</div>

---

## Features

- 📤 **Receive links** (`/r/<code>`) — others upload to you.
- 📦 **Send links** (`/s/<code>`) — bundle files into a download link.
- 🔒 **Per-link policy** — label, password, max-uploads quota, expiry.
- ⚡ **Presigned uploads** — bytes go browser ↔ storage; server handles policy, not bytes.
- 🗂️ **Local or S3** — bytes on disk, or any S3-compatible bucket (R2, MinIO, AWS, B2).
- 🌐 **Optional Cloudflare Tunnel** — public hostname without opening ports.
- 🧑‍💼 **Single admin** — no public signup, no teams.

---

## Build the image

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

---

## Scenario 1: Local storage (no S3)

Bytes live on the mounted `/data` volume alongside the SQLite database.

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

`STORAGE_BACKEND` defaults to `local`. Reverse-proxy `https://files.example.com` to the container's port 3000.

Behind a reverse proxy, also set `-e SECURITY_TRUST_PROXY_HEADERS=true` so rate limiting sees the real client IP (not the proxy's) and admin actions (delete, revoke) and auth actions (sign in, sign out) aren't rejected when the public origin differs from `BETTER_AUTH_URL`. Your proxy must strip incoming `X-Forwarded-*` from clients.

---

## Scenario 2: External S3

Any S3-compatible bucket. Bucket must exist; CORS must allow `PUT` + `GET` from your `BETTER_AUTH_URL` origin and expose `ETag`. A `HeadBucket` probe runs at boot.

```bash
docker run -d \
  --name fileharbor \
  -p 3000:3000 \
  -v fileharbor-data:/data \
  -e BETTER_AUTH_SECRET="$(cat /srv/fileharbor/auth-secret)" \
  -e BETTER_AUTH_URL="https://files.example.com" \
  -e STORAGE_BACKEND=s3 \
  -e S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com" \
  -e S3_ACCESS_KEY_ID="..." \
  -e S3_SECRET_ACCESS_KEY="..." \
  -e S3_BUCKET="fileharbor" \
  -e S3_FORCE_PATH_STYLE=true \
  fileharbor
```

`STORAGE_SIGNING_SECRET` is not used in S3 mode (S3 signs its own URLs). The `/data` volume still holds SQLite.

---

## Scenario 3: Add a Cloudflare Tunnel

The image bundles [`cftunn`](https://github.com/thatjuan/cftunn), which provisions a named Cloudflare Tunnel and the matching DNS record at startup. No port publish needed — Cloudflare routes traffic to the container.

Cloudflare API token scopes: `Zone:DNS:Edit` + `Account:Cloudflare Tunnel:Edit`.

Full local-storage + tunnel example:

```bash
docker run -d \
  --name fileharbor \
  --restart unless-stopped \
  -v fileharbor-data:/data \
  -e BETTER_AUTH_SECRET="$(cat /srv/fileharbor/auth-secret)" \
  -e STORAGE_SIGNING_SECRET="$(cat /srv/fileharbor/storage-secret)" \
  -e CLOUDFLARE_API_TOKEN="..." \
  -e CLOUDFLARE_TUNNEL_DOMAIN="files.example.com" \
  -e SECURITY_TRUST_PROXY_HEADERS=true \
  fileharbor
```

`BETTER_AUTH_URL` auto-derives to `https://${CLOUDFLARE_TUNNEL_DOMAIN}`. Drop `-p 3000:3000` — the tunnel reaches the server inside the container.

`SECURITY_TRUST_PROXY_HEADERS=true` is required behind the tunnel: without it the server sees every request as coming from the tunnel's loopback address, so per-client rate limits collapse into one shared bucket and admin or auth actions (delete, revoke, sign out) can 403 on an origin mismatch. The tunnel is the only thing setting the forwarded headers, so trusting them is safe here.

For S3 + tunnel, combine: drop `-p 3000:3000` from the S3 command above and add the two `CLOUDFLARE_*` vars plus `SECURITY_TRUST_PROXY_HEADERS=true` (you can also drop `BETTER_AUTH_URL`).

Multipart uploads (files >100 MiB) automatically bypass the Cloudflare Free-plan 100 MB body cap.

---

## Custom data location

`/data` is the in-container path. Replace the named volume with any host path:

```bash
-v /mnt/disks/fileharbor:/data
```

SQLite and (in `local` mode) object bytes both live under that mount. To split them, set `LOCAL_OBJECTS_DIR` to a second path and mount that too:

```bash
-v /mnt/disks/fileharbor:/data \
-v /mnt/objects/fileharbor:/objects \
-e LOCAL_OBJECTS_DIR=/objects
```

To change the in-container path itself, set `DATA_DIR` (and mount the new path).

---

## Admin setup

Two options, pick one:

- **Web setup** — open `https://<your-host>/setup` and submit username + password. Route seals after first user.
- **Headless** — set `ADMIN_USERNAME` + `ADMIN_PASSWORD` in the env (both required, ignored after the admin exists).

---

## Config reference

Every value is env-driven. Authoritative list: [`apps/server/src/config.ts`](./apps/server/src/config.ts). Plain template: [`.env.example.clean`](./.env.example.clean). Commented template: [`.env.example`](./.env.example).

| Variable                                            | Purpose                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                | Signs session cookies. Required in production.                  |
| `BETTER_AUTH_URL`                                   | Public base URL. Auto-derived in tunnel mode.                   |
| `STORAGE_BACKEND`                                   | `local` (default) or `s3`.                                      |
| `STORAGE_SIGNING_SECRET`                            | HMAC for local presigned URLs. Required in production (local).  |
| `DATA_DIR`                                          | SQLite + (local mode) bytes. Default `/data` in the image.      |
| `LOCAL_OBJECTS_DIR`                                 | Split local object bytes onto a separate path.                  |
| `S3_*`                                              | Endpoint, keys, bucket. Required when `STORAGE_BACKEND=s3`.     |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD`                 | Headless admin seed. Both or neither.                           |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_TUNNEL_DOMAIN` | Cloudflare Tunnel mode. Both or neither.                        |
| `STORAGE_MULTIPART_THRESHOLD_BYTES`                 | Multipart cut-over. Default 100 MiB.                            |
| `RATE_LIMIT_*`                                      | In-memory abuse limits for auth/setup/public surfaces.          |
| `SECURITY_HEADERS_*`                                | Production security headers and HSTS controls.                  |
| `SECURITY_TRUST_PROXY_HEADERS`                      | Trust forwarded headers (real client IP + public origin). Set `true` behind a trusted proxy/tunnel, off if directly exposed. |

---

## Upgrade

Pull the image, restart, same volume. Drizzle migrations run on every start.

---

## Local development

```bash
npm install
npm run dev
```

Hono API on `:3000`, Vite on `:5173` (proxies `/api/*` to Hono). Default `local` backend, bytes under `./data/objects`.
