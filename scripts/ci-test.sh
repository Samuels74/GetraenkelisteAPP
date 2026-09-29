#!/usr/bin/env bash
# Test runner of the `test` image (make test).
#
# 1. API integration tests (backend/tests)
# 2. E2E tests (e2e/, Playwright: mobile-chrome, mobile-safari, desktop-chrome, qr-camera)
#
# Both suites start their own throw-away PocketBase from the env variables
# PB_BIN, PB_MIGRATIONS_DIR, PB_HOOKS_DIR and PB_PUBLIC_DIR (set in the image).
# Reports are written to $TEST_RESULTS_DIR (api/, e2e/: html-report/, junit.xml,
# artifacts/ with traces of failures, screenshots/, pocketbase.log); the exit
# code is non-zero if any suite failed.
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TEST_RESULTS_DIR="${TEST_RESULTS_DIR:-$APP_DIR/test-results}"
mkdir -p "$TEST_RESULTS_DIR"

status=0
summary=()

run_suite() { # run_suite <name> <dir>
  local name="$1" dir="$2" started=$SECONDS
  echo
  echo "=================== $name tests ==================="
  if (cd "$dir" && npm test); then
    summary+=("$name: passed ($((SECONDS - started)) s)")
  else
    summary+=("$name: FAILED ($((SECONDS - started)) s)")
    status=1
  fi
}

run_suite api "$APP_DIR/backend/tests"

if [ -f "$APP_DIR/e2e/package.json" ]; then
  run_suite e2e "$APP_DIR/e2e"
else
  summary+=("e2e: skipped (no e2e/package.json)")
fi

echo
echo "=================== summary ==================="
printf '  %s\n' "${summary[@]}"
exit "$status"
