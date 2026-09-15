#!/usr/bin/env bash
# Local launcher. Reads an optional .env file and starts the server.
set -euo pipefail

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key." >&2
  exit 1
fi

echo "Starting CANON on http://localhost:${PORT:-3000}"
exec node server.js
