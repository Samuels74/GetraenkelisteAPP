#!/usr/bin/env bash
# `make dev`: local development without containers.
#
# Starts PocketBase (scripts/dev-pocketbase.sh, data in .pb/dev-data) and the
# Vite dev server, which proxies /api and /_ to PocketBase. Ctrl+C stops both.
#
# Environment:
#   PB_PORT    PocketBase port    (default 8090)
#   VITE_PORT  Vite dev port      (default 5173)
#   VITE_ARGS  extra Vite args, e.g. "--host" to reach the dev server from phones
#   + everything supported by scripts/dev-pocketbase.sh (PB_DATA_DIR, PB_SUPERUSER_*, ...)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PB_PORT="${PB_PORT:-8090}"
VITE_PORT="${VITE_PORT:-5173}"
cd "$ROOT"

if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm ci)
fi

PB_HTTP="127.0.0.1:$PB_PORT" scripts/dev-pocketbase.sh &
pb_pid=$!
cleanup() {
  kill "$pb_pid" 2>/dev/null || true
  wait "$pb_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for _ in $(seq 1 150); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PB_PORT/api/health" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$pb_pid" 2>/dev/null; then
    echo "PocketBase exited - see the output above" >&2
    exit 1
  fi
  sleep 0.2
done

echo "PocketBase: http://127.0.0.1:$PB_PORT/_/ (dashboard)  –  app: http://localhost:$VITE_PORT/"
cd frontend
# shellcheck disable=SC2086 # VITE_ARGS is intentionally split
PB_URL="http://127.0.0.1:$PB_PORT" npm run dev -- --port "$VITE_PORT" --strictPort ${VITE_ARGS:-}
