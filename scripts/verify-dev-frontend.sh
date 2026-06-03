#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Verify the dev frontend on disk and (optionally) from the running server.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INDEX="$ROOT/src/index.html"

if ! grep -q 'id="tool-console"' "$INDEX"; then
  echo "FAIL: $INDEX has no #tool-console (save uncommitted UI changes)." >&2
  exit 1
fi
if ! grep -q "llimedit-shell-rev: tool-console-1" "$INDEX"; then
  echo "FAIL: $INDEX is missing shell rev marker tool-console-1." >&2
  exit 1
fi
echo "OK: on-disk index.html includes tool-console."

if curl -sf "http://127.0.0.1:1420/index.html" -o /tmp/llimedit-index-check.html 2>/dev/null; then
  if grep -q 'id="tool-console"' /tmp/llimedit-index-check.html; then
    echo "OK: dev server at :1420 serves tool-console."
  else
    echo "FAIL: dev server at :1420 does NOT serve tool-console (stale server?)." >&2
    echo "Run: npm run dev:clean && npm run dev" >&2
    exit 1
  fi
else
  echo "Note: dev server not running on :1420 (start with npm run dev)."
fi
