#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ]; then
  echo "[demo.sh] installing npm dependencies..." >&2
  npm install --no-fund --no-audit >/dev/null
fi

exec npx --no-install tsx src/demo.ts "$@"
