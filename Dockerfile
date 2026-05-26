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

ARG CFTUNN_VERSION=v0.5.0
ARG TARGETARCH

# Install runtime tunnel tooling in a single layer:
#   - cloudflared (from Cloudflare's apt repo)
#   - cftunn (release tarball from github.com/thatjuan/cftunn, sha256-verified)
#   - tini   (PID 1 reaper for the entrypoint)
# curl and gnupg are purged at the end of the layer to keep the image lean.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg tini; \
    mkdir -p /usr/share/keyrings; \
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main" \
        > /etc/apt/sources.list.d/cloudflared.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends cloudflared; \
    case "${TARGETARCH}" in \
        amd64) CFTUNN_ARCH=x86_64 ;; \
        arm64) CFTUNN_ARCH=arm64 ;; \
        *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSL -o "cftunn_Linux_${CFTUNN_ARCH}.tar.gz" \
        "https://github.com/thatjuan/cftunn/releases/download/${CFTUNN_VERSION}/cftunn_Linux_${CFTUNN_ARCH}.tar.gz"; \
    curl -fsSL -o checksums.txt \
        "https://github.com/thatjuan/cftunn/releases/download/${CFTUNN_VERSION}/checksums.txt"; \
    grep " cftunn_Linux_${CFTUNN_ARCH}.tar.gz\$" checksums.txt | sha256sum -c -; \
    tar -xzf "cftunn_Linux_${CFTUNN_ARCH}.tar.gz"; \
    install -o root -g root -m 0755 cftunn /usr/local/bin/cftunn; \
    rm -f cftunn "cftunn_Linux_${CFTUNN_ARCH}.tar.gz" checksums.txt LICENSE README.md; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*

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

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Persist SQLite + future state on a mountable volume.
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]
USER node

EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
