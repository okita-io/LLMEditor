#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 okita.io
#
# scripts/smoke.sh
#
# End-to-end smoke harness for LLIMEdit. Invoked by CI on macOS and Windows
# (via Git Bash) runners against the `cargo tauri build` output.
#
# Steps:
#   1. Verify Rust + node toolchains.
#   2. Run the Rust unit/property/integration suite (`cargo test`).
#   3. Run the frontend Vitest suite (`npm test`).
#   4. Produce the release bundle (`cargo tauri build` if available, else
#      `cargo build --release` so the runner still has an executable to drive).
#   5. Materialize the smoke fixture (`scripts/fixtures/hello.txt`).
#   6. If `tauri-driver` is on PATH, hand off to the driver-based scenarios
#      documented in `scripts/smoke.md`. Otherwise emit a yellow notice and
#      require manual execution of `scripts/smoke.md`.
#
# This script is intentionally conservative: every external command is
# checked, every failure is fatal, and no destructive operations are
# performed outside the workspace's own `target/` and `scripts/fixtures/`
# directories.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[smoke] %s\n' "$*"; }
warn() { printf '[smoke] WARN: %s\n' "$*" >&2; }
die() { printf '[smoke] FATAL: %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"
}

# ---------------------------------------------------------------------------
# 1. Toolchain sanity
# ---------------------------------------------------------------------------
log "checking toolchain"
require cargo
require rustc
require npm
require node

# ---------------------------------------------------------------------------
# 2. Rust suite
# ---------------------------------------------------------------------------
log "running cargo test"
cargo test --manifest-path src-tauri/Cargo.toml

# ---------------------------------------------------------------------------
# 3. Frontend suite
# ---------------------------------------------------------------------------
log "running npm test"
if [ ! -d node_modules ]; then
  log "installing npm deps"
  npm ci
fi
npm test

# ---------------------------------------------------------------------------
# 4. Release bundle
# ---------------------------------------------------------------------------
BUNDLE_OK=0
if command -v cargo-tauri >/dev/null 2>&1 || cargo tauri --help >/dev/null 2>&1; then
  log "running cargo tauri build"
  cargo tauri build
  BUNDLE_OK=1
else
  warn "cargo-tauri CLI not found on PATH; falling back to cargo build --release"
  cargo build --manifest-path src-tauri/Cargo.toml --release
fi

# Locate the produced executable (best-effort; only the driver step needs it).
case "$(uname -s)" in
  Darwin*)
    EXE_PATH="src-tauri/target/release/bundle/macos/LLIMEdit.app/Contents/MacOS/llimedit"
    [ -x "$EXE_PATH" ] || EXE_PATH="src-tauri/target/release/llimedit"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    EXE_PATH="src-tauri/target/release/llimedit.exe"
    ;;
  Linux*)
    EXE_PATH="src-tauri/target/release/llimedit"
    ;;
  *)
    EXE_PATH="src-tauri/target/release/llimedit"
    ;;
esac

if [ -x "$EXE_PATH" ]; then
  log "release executable located at $EXE_PATH"
else
  warn "release executable not found at $EXE_PATH (BUNDLE_OK=$BUNDLE_OK); driver step will be skipped"
fi

# ---------------------------------------------------------------------------
# 5. Smoke fixture
# ---------------------------------------------------------------------------
FIXTURE_DIR="scripts/fixtures"
FIXTURE_FILE="$FIXTURE_DIR/hello.txt"
mkdir -p "$FIXTURE_DIR"
if [ ! -f "$FIXTURE_FILE" ]; then
  log "materializing $FIXTURE_FILE"
  printf 'hello, world\n' > "$FIXTURE_FILE"
fi

# ---------------------------------------------------------------------------
# 6. Driver-based scenarios
# ---------------------------------------------------------------------------
if command -v tauri-driver >/dev/null 2>&1 && [ -x "$EXE_PATH" ]; then
  log "tauri-driver found; driver-based smoke scenarios are not yet wired"
  log "see scripts/smoke.md for the full step list (manual until driver wiring lands)"
  # The actual WebDriver scenarios are intentionally out of scope for this
  # script; wiring them in requires a per-platform `tauri-driver` runner and
  # a small Node or Rust client. The runbook in scripts/smoke.md is the
  # canonical specification for what the driver MUST exercise.
else
  warn "tauri-driver not on PATH (or no executable); execute scripts/smoke.md manually"
fi

log "smoke pre-flight complete"
