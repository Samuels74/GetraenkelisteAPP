#!/usr/bin/env bash
# Waits until the app container (make run) answers on /api/health and prints
# its URL.
#
# usage: scripts/wait-for-app.sh [port] [timeout seconds]
#
# The containers run on the Podman host. From the host they are reachable via
# localhost, from inside a dev container via host.containers.internal – both
# are tried unless HEALTH_HOST (space separated list) is set; BIND (make run)
# is tried first when it is one specific address. A port published on the
# Podman host's loopback (BIND=127.0.0.1) cannot be reached from a dev
# container: with BIND set, the image's health check inside the container
# decides then. Gives up early, with the last logs, when the container stops
# or restarts (e.g. a rejected PB_ENCRYPTION_KEY) – and stops it, so that its
# restart policy does not keep restarting it.
#
# Environment: CONTAINER (default getraenkeliste), PODMAN (default podman), BIND.
set -uo pipefail

PORT="${1:-8090}"
TIMEOUT="${2:-60}"
HOSTS="${HEALTH_HOST:-localhost host.containers.internal}"
CONTAINER="${CONTAINER:-getraenkeliste}"
PODMAN="${PODMAN:-podman}"
BIND="${BIND:-}"
case "$BIND" in
  '' | 0.0.0.0 | :: | '[::]' | 127.0.0.1 | localhost) ;;
  *) HOSTS="$BIND $HOSTS" ;;
esac

probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 2 "$1"
  else
    wget -q -O /dev/null -T 2 "$1"
  fi
}

reachable() { # prints the URLs if one of the hosts answers
  local host
  for host in $HOSTS; do
    if probe "http://$host:$PORT/api/health" 2>/dev/null; then
      echo "Getränkeliste is running: http://$host:$PORT/"
      echo "  dashboard (superusers): http://$host:$PORT/_/"
      echo "  from other devices use the host's IP/name, or HTTPS via the reverse proxy (see deploy/reverse-proxy.md)"
      return 0
    fi
  done
  return 1
}

# shellcheck disable=SC2086 # PODMAN may be a command with arguments
show_logs() { $PODMAN logs --tail 30 "$CONTAINER" >&2 || true; }

deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  reachable && exit 0
  # shellcheck disable=SC2086
  state="$($PODMAN container inspect --format '{{.State.Status}} {{.RestartCount}}' "$CONTAINER" 2>/dev/null)"
  case "$state" in
    '' | 'running 0') ;; # starting (or not inspectable: keep probing)
    *)
      echo "The container $CONTAINER stopped or restarted (status ${state% *}, restarts ${state##* }). Last logs:" >&2
      show_logs
      # End the restart loop: `stop` alone does not stick while a restart is
      # under way, so drop the restart policy first (Podman < 5: remove it).
      # shellcheck disable=SC2086
      if $PODMAN update --restart=no "$CONTAINER" >/dev/null 2>&1; then
        $PODMAN stop --ignore "$CONTAINER" >/dev/null 2>&1 || true
        echo "Stopped $CONTAINER (no restart loop) - fix the cause and run it again." >&2
      else
        $PODMAN rm -f --ignore "$CONTAINER" >/dev/null 2>&1 || true
        echo "Removed $CONTAINER (no restart loop) - fix the cause and run it again." >&2
      fi
      exit 1
      ;;
  esac
  # shellcheck disable=SC2086
  if [ -n "$BIND" ] && $PODMAN healthcheck run "$CONTAINER" >/dev/null 2>&1; then
    reachable && exit 0
    echo "Getränkeliste is running (healthy) on $BIND:$PORT of the Podman host - not reachable from here (tried: $HOSTS)."
    exit 0
  fi
  sleep 1
done

echo "The app did not become healthy within ${TIMEOUT}s (tried: $HOSTS, port $PORT). Last logs:" >&2
show_logs
exit 1
