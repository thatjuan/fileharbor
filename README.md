# File Harbor

Self-hosted, single-binary file send/receive service. Run in your home lab, Docker host, or VPS.

Stack: TypeScript, Node.js, Hono, React + Vite, SQLite + Drizzle, Better Auth. S3-compatible storage required (Cloudflare R2, MinIO, AWS S3, etc.) — File Harbor never proxies file bytes.

Status: pre-implementation. See open issues for the PRD and milestones.

## Repository layout

```
apps/
  server/     Hono API + production-mode static file serving
  web/        React + Vite frontend
Dockerfile    Multi-stage build → single runtime image
```

The two workspaces share a root `package.json` (npm workspaces) and a shared `tsconfig.base.json`. Server and web are independently buildable but always shipped together inside one container.

## Running with Docker

```bash
docker build -t fileharbor .
docker run -d -p 3000:3000 -v fileharbor-data:/data fileharbor
```

The container exposes port `3000`. SQLite (and any future state) lives under the `/data` volume; mount a host directory or a named volume if you want it to persist across container removals.

Drizzle migrations run automatically on container start. The migrator records applied migrations in `__drizzle_migrations` inside the DB, so subsequent starts are no-ops.

## Local development

```bash
npm install
npm run dev
```

This starts:

- the Hono server on `http://localhost:3000` (API only in dev — no static serving)
- the Vite dev server on `http://localhost:5173` with `/api/*` proxied to the Hono server

Open `http://localhost:5173` for the app.

## Configuration

All configuration is env-var-driven. See `.env.example` for the full list.

| Variable             | Default                               | Purpose                                                        |
| -------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `PORT`               | `3000`                                | HTTP port the Node process binds to                            |
| `DATA_DIR`           | `/data` (in Docker), `./data` (local) | Directory holding SQLite + future state                        |
| `DATABASE_URL`       | `${DATA_DIR}/fileharbor.db`           | Override the DB path. Accepts `file:` URLs or raw paths        |
| `NODE_ENV`           | `production` (in Docker)              | When `production`, the server also serves the built frontend   |
| `WEB_DIST_DIR`       | `/app/web` (in Docker)                | Where to find the built frontend in production                 |
| `BETTER_AUTH_SECRET` | _required in prod_                    | Signs session cookies. Auto-generated per-process in dev       |
| `BETTER_AUTH_URL`    | `http://localhost:${PORT}`            | Public base URL for cookie host / callbacks                    |
| `ADMIN_USERNAME`     | unset                                 | Optional: with `ADMIN_PASSWORD`, seeds the admin on first boot |
| `ADMIN_PASSWORD`     | unset                                 | Optional: with `ADMIN_USERNAME`, seeds the admin on first boot |

## First-run setup

On first boot File Harbor exposes a single setup route — `/setup` in the
browser, `POST /api/setup` in the API — that lets you create the one admin
account. After that user exists both surfaces seal: `POST /api/setup` returns
403 and the SPA bounces `/setup` to the dashboard. There is no public sign-up
endpoint at any point.

For headless deploys, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the
environment. If both are set and no user exists at boot, File Harbor creates
the admin during startup before the HTTP server begins accepting requests.

## Contributing

See `CONTRIBUTING.md` for how PRDs and execution issues work.
