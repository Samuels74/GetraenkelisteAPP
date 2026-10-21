#!/usr/bin/env bash
# `make dev`: local development without containers.
#
# Starts PocketBase (scripts/dev-pocketbase.sh, data in .pb/dev-data) and the
# Vite dev server, which proxies /api and /_ to PocketBase. Ctrl+C stops both;
# when one of the two exits, the other one is stopped too.
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
PB_URL="http://127.0.0.1:$PB_PORT"
cd "$ROOT"

if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm ci)
fi
# download (and verify) PocketBase first: the wait below only covers its start
scripts/dev-pocketbase.sh --download-only

healthy() { curl -fsS -o /dev/null --max-time 2 "$PB_URL/api/health" 2>/dev/null; }
running() { kill -0 "$1" 2>/dev/null; }

# Vite proxies to whatever answers on PB_PORT: with another server there (e.g.
# `make run`, also 8090) our PocketBase cannot bind, and the app would silently
# work on that server's data.
if healthy; then
  echo "port $PB_PORT is in use: $PB_URL/api/health already answers - is \`make run\` running (\`make stop\`)? Or use another PB_PORT." >&2
  exit 1
fi

pb_pid=
vite_pid=
cleanup() {
  if [ -n "$vite_pid" ]; then kill "$vite_pid" 2>/dev/null || true; fi
  if [ -n "$pb_pid" ]; then
    kill "$pb_pid" 2>/dev/null || true
    wait "$pb_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

PB_HTTP="127.0.0.1:$PB_PORT" scripts/dev-pocketbase.sh &
pb_pid=$!
pb_exited() {
  echo "PocketBase exited${1:-} - see the output above" >&2
  exit 1
}

# Ready = /api/health answers while our PocketBase runs – and still runs a
# moment later: a server that took the port meanwhile would answer as well,
# and ours would exit with "address already in use".
ready=false
for _ in $(seq 1 150); do
  running "$pb_pid" || pb_exited
  if healthy; then
    ready=true
    break
  fi
  sleep 0.2
done
[ "$ready" = true ] || { echo "PocketBase did not answer on $PB_URL within 30 s" >&2; exit 1; }
sleep 0.5
running "$pb_pid" || pb_exited

echo "PocketBase: $PB_URL/_/ (dashboard)  –  app: http://localhost:$VITE_PORT/"
# Vite itself, not `npm run dev` (= vite): npm does not pass a signal on through
# its `sh -c`, so stopping npm would leave Vite running. In the background with
# the terminal as stdin (Vite's keyboard shortcuts), until one of the two exits.
# shellcheck disable=SC2086 # VITE_ARGS is intentionally split
(cd frontend && PB_URL="$PB_URL" exec ./node_modules/.bin/vite --port "$VITE_PORT" --strictPort ${VITE_ARGS:-}) <&0 &
vite_pid=$!
while running "$pb_pid" && running "$vite_pid"; do
  sleep 1
done
running "$pb_pid" || pb_exited " - stopping Vite"
status=0
wait "$vite_pid" || status=$?
echo "Vite exited (status $status) - stopping PocketBase" >&2
exit "$status"
