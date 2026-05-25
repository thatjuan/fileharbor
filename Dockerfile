# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Stage 1: install all workspace deps (frontend + server) once.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for node 22 on linux x64/arm64, so no
# C toolchain is required at install time. If a future native dep needs one,
# add `python3 make g++` here.

COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

# `npm install` (not `ci`) is intentional pre-lockfile-commit. Once a
# `package-lock.json` is committed, switch to `npm ci` for reproducible builds.
RUN --mount=type=cache,target=/root/.npm npm install --workspaces --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 2: build the frontend (Vite) and the server (tsc).
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json tsconfig.json ./
COPY apps ./apps

# Vite emits to apps/web/dist; tsc emits to apps/server/dist.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: production image. Slim Node + only what's needed at runtime.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/web

# Better-sqlite3 ships a prebuilt binary for node 22 on common platforms, so
# the runtime image doesn't need a compiler.

COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/package.json

RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --workspace @fileharbor/server --include-workspace-root

# Built server output, drizzle migrations metadata, and the built frontend.
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/drizzle ./drizzle
COPY --from=build /app/apps/web/dist ./web

# Persist SQLite + future state on a mountable volume.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
