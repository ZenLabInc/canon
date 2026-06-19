#!/usr/bin/env bash
# Local dev launcher. Fetches GEMINI_API_KEY from ZenMedia's AWS Secrets Manager
# (requires an active `aws sso login` session) and starts the server.
# The key is only ever held in this process's environment — never written to disk.
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
SECRET_ID="${SECRET_ID:-zenmedia/app}"

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "Fetching GEMINI_API_KEY from $SECRET_ID ($REGION)…"
  GEMINI_API_KEY="$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET_ID" --region "$REGION" \
    --query SecretString --output text \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["GEMINI_API_KEY"])')"
  export GEMINI_API_KEY
fi

echo "Starting CANON on http://localhost:${PORT:-3000}"
exec node server.js
