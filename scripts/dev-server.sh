#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Serves src/ for Tauri dev (beforeDevCommand). Path is repo-root relative.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/src"
if ! grep -q 'id="tool-console"' index.html; then
  echo "error: $ROOT/src/index.html is missing #tool-console — save your working tree changes before starting dev." >&2
  exit 1
fi
exec python3 "$ROOT/scripts/dev_server.py" --directory "$ROOT/src" --port 1420 --bind 127.0.0.1
