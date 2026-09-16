#!/bin/sh
set -e
# Local disk is disposable. Pull mind from object storage, exec the worker, push on exit.
if [ -z "$MEMORY_STORE_DIR" ] || [ -z "$MEMORY_PREFIX" ] || [ -z "$MEMORY_DIR" ]; then
  echo "[runtime] MEMORY_STORE_DIR, MEMORY_PREFIX, MEMORY_DIR must be set"
  exit 1
fi
node /app/packages/hydrate/dist/cli.js pull
trap 'node /app/packages/hydrate/dist/cli.js push' EXIT
exec "$@"
