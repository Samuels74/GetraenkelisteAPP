#!/usr/bin/env bash
# Local development PocketBase.
#
# Downloads PocketBase into .pb/ (gitignored) if it is missing or has the wrong
# version – verified against the release checksums.txt – and runs `serve` with
# the repo's migrations, hooks and the built SPA (frontend/dist) as public dir.
#
# Usage:
#   scripts/dev-pocketbase.sh                  # download if needed, then serve
#   scripts/dev-pocketbase.sh --download-only  # only make sure .pb/pocketbase exists
#   scripts/dev-pocketbase.sh --dev            # extra args are passed to `serve`
#
# Environment (all optional):
#   PB_VERSION            PocketBase version                  (default 0.40.4)
#   PB_HTTP               listen address                      (default 127.0.0.1:8090)
#   PB_DATA_DIR           data dir, relative to the repo root (default .pb/dev-data)
#   PB_PUBLIC_DIR         static files dir                    (default frontend/dist)
#   PB_AUTOMIGRATE        true = schema edits in the dashboard write migration
#                         files into backend/pb_migrations    (default false)
#   PB_SUPERUSER_EMAIL    if both are set, this dashboard superuser is
#   PB_SUPERUSER_PASSWORD upserted before the server starts
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PB_VERSION="${PB_VERSION:-0.40.4}"
PB_HTTP="${PB_HTTP:-127.0.0.1:8090}"
PB_DATA_DIR="${PB_DATA_DIR:-.pb/dev-data}"
PB_PUBLIC_DIR="${PB_PUBLIC_DIR:-frontend/dist}"
PB_AUTOMIGRATE="${PB_AUTOMIGRATE:-false}"
PB_HOME="$ROOT/.pb"
PB_BIN="$PB_HOME/pocketbase"

log() { printf '[dev-pocketbase] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

abs_path() { # resolve relative paths against the repo root
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$ROOT/$1" ;;
  esac
}

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l | armv7) arch=armv7 ;;
    *) die "unsupported CPU architecture $(uname -m)" ;;
  esac
  printf '%s_%s\n' "$os" "$arch"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fetch() { # fetch <url> <output file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

unzip_pocketbase() { # unzip_pocketbase <zip> <target dir>
  if command -v unzip >/dev/null 2>&1; then
    unzip -o -q "$1" pocketbase -d "$2"
  else
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract("pocketbase", sys.argv[2])' "$1" "$2"
  fi
}

installed_version() {
  [ -x "$PB_BIN" ] || return 0
  "$PB_BIN" --version 2>/dev/null | awk '{print $NF}'
}

ensure_pocketbase() {
  if [ "$(installed_version)" = "$PB_VERSION" ]; then
    return 0
  fi

  local platform zip base tmp expected actual
  platform="$(detect_platform)"
  zip="pocketbase_${PB_VERSION}_${platform}.zip"
  base="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}"
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand $tmp now
  trap "rm -rf '$tmp'" RETURN

  log "downloading PocketBase v${PB_VERSION} (${platform}) ..."
  fetch "$base/$zip" "$tmp/$zip"
  fetch "$base/checksums.txt" "$tmp/checksums.txt"

  expected="$(awk -v f="$zip" '$2 == f {print $1}' "$tmp/checksums.txt")"
  [ -n "$expected" ] || die "$zip is not listed in checksums.txt"
  actual="$(sha256_of "$tmp/$zip")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for $zip (expected $expected, got $actual)"
  log "checksum ok ($actual)"

  unzip_pocketbase "$tmp/$zip" "$tmp/x"
  mkdir -p "$PB_HOME"
  install -m 0755 "$tmp/x/pocketbase" "$PB_BIN"
  cp "$tmp/checksums.txt" "$PB_HOME/checksums.txt"
  log "installed $PB_BIN ($("$PB_BIN" --version))"
}

ensure_pocketbase

if [ "${1:-}" = "--download-only" ]; then
  exit 0
fi

DATA_DIR="$(abs_path "$PB_DATA_DIR")"
PUBLIC_DIR="$(abs_path "$PB_PUBLIC_DIR")"
common_args=(
  "--dir=$DATA_DIR"
  "--migrationsDir=$ROOT/backend/pb_migrations"
  "--hooksDir=$ROOT/backend/pb_hooks"
  "--automigrate=$PB_AUTOMIGRATE"
)

if [ -n "${PB_SUPERUSER_EMAIL:-}" ] && [ -n "${PB_SUPERUSER_PASSWORD:-}" ]; then
  log "upserting superuser $PB_SUPERUSER_EMAIL"
  "$PB_BIN" superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" "${common_args[@]}" --hooksWatch=false
fi

[ -d "$PUBLIC_DIR" ] || log "note: $PUBLIC_DIR does not exist yet (run the frontend build or use the Vite dev server)"

log "serving on http://$PB_HTTP (data: $DATA_DIR)"
exec "$PB_BIN" serve "${common_args[@]}" "--publicDir=$PUBLIC_DIR" "--http=$PB_HTTP" "$@"
