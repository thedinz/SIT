#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"

# Start as root only long enough to hand the data folders to the unprivileged node user.
# Existing installs created those folders as root, so fix ownership before dropping privileges.
if [ "$(id -u)" = "0" ] && [ "${RUN_AS_ROOT:-false}" != "true" ]; then
  mkdir -p "$DATA_DIR"
  if find "$DATA_DIR" ! -user node -exec chown node:node {} + 2>/dev/null; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  echo "Warning: could not give $DATA_DIR to the node user; running as root instead." >&2
fi

exec "$@"
