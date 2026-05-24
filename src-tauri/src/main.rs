// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — Tauri binary entry point. Delegates to the library crate so the
// same logic is available to integration tests and to the mobile entry-point.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    llimedit_lib::run();
}
