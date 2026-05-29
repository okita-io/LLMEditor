#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Stop stale LLIMEdit dev processes (safe to run before npm run dev).
pkill -f "cargo-tauri tauri dev" 2>/dev/null || true
pkill -f "target/debug/llimedit" 2>/dev/null || true
pkill -f "python3 -m http.server 1420" 2>/dev/null || true
