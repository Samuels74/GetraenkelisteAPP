#!/usr/bin/env bash
# Waits until the app answers on /api/health and prints its URL.
#
# usage: scripts/wait-for-app.sh [port] [timeout seconds]
#
# The containers run on the Podman host. From the host they are reachable via
# localhost, from inside a dev container via host.containers.internal – both
# are tried unless HEALTH_HOST (space separated list) is set.
set -uo pipefail

PORT="${1:-8090}"
TIMEOUT="${2:-60}"
HOSTS="${HEALTH_HOST:-localhost host.containers.internal}"
CONTAINER="${CONTAINER:-getraenkeliste}"

probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 2 "$1"
  else
    wget -q -O /dev/null -T 2 "$1"
  fi
}

deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  for host in $HOSTS; do
    if probe "http://$host:$PORT/api/health" 2>/dev/null; then
      echo "Getränkeliste is running: http://$host:$PORT/"
      echo "  dashboard (superusers): http://$host:$PORT/_/"
      echo "  from other devices use the host's IP/name, or HTTPS via the reverse proxy (see deploy/reverse-proxy.md)"
      exit 0
    fi
  done
  sleep 1
done

echo "The app did not become healthy within ${TIMEOUT}s (tried: $HOSTS, port $PORT). Last logs:" >&2
podman logs --tail 30 "$CONTAINER" >&2 || true
exit 1
