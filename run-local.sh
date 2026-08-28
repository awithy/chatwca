#!/usr/bin/env bash

set -euo pipefail

# Always run from the repository root, regardless of where this script is called.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Error: Node.js 22.19.0 or newer and npm are required." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm ci
fi

# Bind to loopback by default so the unauthenticated app is not exposed to the LAN.
# Read host/port through Node so .env uses the same parser and precedence as the server.
if [[ -f .env ]]; then
  export CHATWCA_HOST="$(node --env-file=.env -p 'process.env.CHATWCA_HOST ?? "127.0.0.1"')"
  export CHATWCA_PORT="$(node --env-file=.env -p 'process.env.CHATWCA_PORT ?? "8787"')"
else
  export CHATWCA_HOST="${CHATWCA_HOST:-127.0.0.1}"
  export CHATWCA_PORT="${CHATWCA_PORT:-8787}"
fi

npm run build

echo "Starting ChatWCA at http://${CHATWCA_HOST}:${CHATWCA_PORT}"
exec npm start
