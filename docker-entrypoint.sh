#!/usr/bin/env bash
set -euo pipefail

NODE_PID=
CFTUNN_PID=

term() {
    [ -n "${CFTUNN_PID}" ] && kill -TERM "${CFTUNN_PID}" 2>/dev/null || true
    [ -n "${NODE_PID}" ]   && kill -TERM "${NODE_PID}"   2>/dev/null || true
}
trap term TERM INT

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_TUNNEL_DOMAIN:-}" ]; then
    PORT="${PORT:-3000}"
    echo "[fileharbor] starting cftunn for ${CLOUDFLARE_TUNNEL_DOMAIN} on port ${PORT}"
    cftunn "${PORT}" "${CLOUDFLARE_TUNNEL_DOMAIN}" &
    CFTUNN_PID=$!
fi

node dist/index.js &
NODE_PID=$!

# Wait for whichever child exits first. Surface that child's exit code so the
# container's restart policy can act on a tunnel failure as well as a server crash.
EXIT_CODE=0
if [ -n "${CFTUNN_PID}" ]; then
    set +e
    wait -n "${NODE_PID}" "${CFTUNN_PID}"
    EXIT_CODE=$?
    set -e
    # Whichever survived gets a TERM; brief grace, then KILL.
    term
    sleep 2
    [ -n "${CFTUNN_PID}" ] && kill -KILL "${CFTUNN_PID}" 2>/dev/null || true
    [ -n "${NODE_PID}" ]   && kill -KILL "${NODE_PID}"   2>/dev/null || true
    wait "${NODE_PID}" 2>/dev/null || true
    wait "${CFTUNN_PID}" 2>/dev/null || true
else
    wait "${NODE_PID}"
    EXIT_CODE=$?
fi

exit "${EXIT_CODE}"
