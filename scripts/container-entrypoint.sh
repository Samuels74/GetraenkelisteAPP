#!/bin/sh
# Entrypoint of the runtime image (see Containerfile).
#
# Optional environment:
#   PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD
#       upserts this superuser (PocketBase dashboard at /_/) before starting;
#       only one of the two set is ignored with a warning. Keyed by the e-mail:
#       a changed e-mail adds a superuser, the old one stays valid.
#   PB_ENCRYPTION_KEY
#       exactly 32 characters (e.g. `openssl rand -hex 16`); encrypts the stored
#       app settings (e.g. SMTP/S3 secrets). Must stay the same for the lifetime
#       of the data volume and its backups. Any other length stops the start
#       with exit code 64 (PocketBase itself would fail with a bare
#       "crypto/aes: invalid key size", or take 16/24 characters as a weaker key).
#
# Extra container arguments are passed on to `pocketbase serve` – but not
# --http: the image's health check and the published port expect 0.0.0.0:8090.
set -eu

PB=/usr/local/bin/pocketbase

# The dashboard must not write migration files into the image and the hooks
# never change at runtime.
COMMON_ARGS="--dir=/pb_data --migrationsDir=/app/pb_migrations --hooksDir=/app/pb_hooks --automigrate=false --hooksWatch=false"
if [ -n "${PB_ENCRYPTION_KEY:-}" ]; then
  # bytes, as AES counts them ($((…)) drops the padding of busybox wc)
  key_length=$(($(printf %s "$PB_ENCRYPTION_KEY" | wc -c)))
  if [ "$key_length" -ne 32 ]; then
    echo "entrypoint: PB_ENCRYPTION_KEY must be exactly 32 characters, got $key_length - e.g. \`openssl rand -hex 16\` (quotes in an env file count as characters)" >&2
    exit 64
  fi
  COMMON_ARGS="$COMMON_ARGS --encryptionEnv=PB_ENCRYPTION_KEY"
fi

if [ -n "${PB_SUPERUSER_EMAIL:-}" ] && [ -n "${PB_SUPERUSER_PASSWORD:-}" ]; then
  echo "entrypoint: upserting superuser ${PB_SUPERUSER_EMAIL}"
  # not fatal: a rejected password (e.g. too short) must not stop the app
  # shellcheck disable=SC2086 # intentional word splitting of COMMON_ARGS
  "$PB" superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" $COMMON_ARGS ||
    echo "entrypoint: WARNING - could not upsert the superuser (see the error above)" >&2
elif [ -n "${PB_SUPERUSER_EMAIL:-}${PB_SUPERUSER_PASSWORD:-}" ]; then
  echo "entrypoint: WARNING - PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD must both be set - no superuser upserted" >&2
fi

for arg in "$@"; do
  case "$arg" in
    --http | --http=*)
      echo "entrypoint: WARNING - $arg: the health check and the published port expect the default --http=0.0.0.0:8090" >&2
      ;;
  esac
done

# shellcheck disable=SC2086
exec "$PB" serve --http=0.0.0.0:8090 --publicDir=/app/pb_public $COMMON_ARGS "$@"
