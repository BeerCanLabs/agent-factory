#!/bin/sh
set -e
# Local disk is disposable. Pull mind from object storage, exec the worker, push on exit.
if [ -z "$MEMORY_DIR" ]; then
  echo "[runtime] MEMORY_DIR must be set"
  exit 1
fi
mkdir -p "$MEMORY_DIR"

if [ -n "$MEMORY_STORE_URI" ] && echo "$MEMORY_STORE_URI" | grep -q '^s3://'; then
  PREFIX="${MEMORY_PREFIX:-}"
  SRC="${MEMORY_STORE_URI%/}/${PREFIX}"
  aws s3 sync "$SRC" "$MEMORY_DIR" || true
  trap 'aws s3 sync "$MEMORY_DIR" "$SRC"' EXIT
  exec "$@"
fi

if [ -z "$MEMORY_STORE_DIR" ] || [ -z "$MEMORY_PREFIX" ]; then
  echo "[runtime] MEMORY_STORE_DIR and MEMORY_PREFIX must be set when MEMORY_STORE_URI is not s3"
  exit 1
fi
node /app/packages/hydrate/dist/cli.js pull
trap 'node /app/packages/hydrate/dist/cli.js push' EXIT
exec "$@"
