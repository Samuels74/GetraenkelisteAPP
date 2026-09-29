#!/bin/sh
# Entrypoint of the runtime image (see Containerfile).
#
# Optional environment:
#   PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD
#       upserts this superuser (PocketBase dashboard at /_/) before starting
#   PB_ENCRYPTION_KEY
#       32 characters; encrypts the stored app settings (e.g. SMTP/S3 secrets).
#       Must stay the same for the lifetime of the data volume.
#
# Extra container arguments are passed on to `pocketbase serve`.
set -eu

PB=/usr/local/bin/pocketbase

# The dashboard must not write migration files into the image and the hooks
# never change at runtime.
COMMON_ARGS="--dir=/pb_data --migrationsDir=/app/pb_migrations --hooksDir=/app/pb_hooks --automigrate=false --hooksWatch=false"
if [ -n "${PB_ENCRYPTION_KEY:-}" ]; then
  COMMON_ARGS="$COMMON_ARGS --encryptionEnv=PB_ENCRYPTION_KEY"
fi

if [ -n "${PB_SUPERUSER_EMAIL:-}" ] && [ -n "${PB_SUPERUSER_PASSWORD:-}" ]; then
  echo "entrypoint: upserting superuser ${PB_SUPERUSER_EMAIL}"
  # not fatal: a rejected password (e.g. too short) must not stop the app
  # shellcheck disable=SC2086 # intentional word splitting of COMMON_ARGS
  "$PB" superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" $COMMON_ARGS ||
    echo "entrypoint: WARNING - could not upsert the superuser (see the error above)" >&2
fi

# shellcheck disable=SC2086
exec "$PB" serve --http=0.0.0.0:8090 --publicDir=/app/pb_public $COMMON_ARGS "$@"
