#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Serves src/ for Tauri dev (beforeDevCommand). Path is repo-root relative.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/src"
exec python3 -m http.server 1420 --bind 127.0.0.1
