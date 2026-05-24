// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — library crate. Houses the Tauri builder bootstrap and a small
// pure helper (`apply_load_outcome`) that the bootstrap warm-up task uses
// to fold `Settings_Service::load`'s `LoadOutcome` into `AppState`. The
// helper is factored out of the `setup` closure so it can be unit-tested
// against an in-memory `AppState` without spinning up a Tauri runtime.
//
// Backend modules (file_service, settings_service, llm_client, …) live in
// sibling files; this entry point only owns the builder and the warm-up
// glue.

pub mod commands;
pub mod error;
pub mod events;
pub mod file_service;
pub mod llm_client;
pub mod settings;
pub mod settings_service;
pub mod state;

use std::sync::atomic::Ordering;

use tauri::Manager;

use crate::settings_service::LoadOutcome;
use crate::state::AppState;

/// Fold `Settings_Service::load`'s `LoadOutcome` into the in-memory
/// `AppState` and flip the `settings_ready` flag.
///
/// All three arms of `LoadOutcome` carry a usable `Settings` value (the
/// `DefaultsFromError` arm carries `Settings::default()`), so this function
/// always overwrites the cached settings with the freshly-loaded value
/// before flipping the readiness flag. The order matters: the flag MUST be
/// stored *after* the cache is populated so any frontend code that sees
/// `settings_ready == true` and immediately calls `load_settings` cannot
/// observe the pre-bootstrap defaults instead of the loaded values.
///
/// On `DefaultsFromError(_, reason)` the reason is logged at `warn!` so it
/// shows up in `tauri-plugin-log`'s sink without surfacing in the UI;
/// `load_settings` is the contract surface for the user-facing failure
/// reason (it re-runs `Settings_Service::load` on demand and re-derives the
/// reason there). The `_` binding is preserved on the value so callers
/// reading this code see exactly what is — and is not — propagated to the
/// frontend.
///
/// Used by the `tauri::Builder::setup` warm-up task in `run()` and by the
/// unit tests below; nothing else in the workspace should call it.
pub fn apply_load_outcome(state: &AppState, outcome: LoadOutcome) {
    let settings = match outcome {
        LoadOutcome::Ok(s) => s,
        LoadOutcome::DefaultsCreated(s) => s,
        LoadOutcome::DefaultsFromError(s, reason) => {
            // The reason is the user-facing string emitted by
            // `Settings_Service`; logging at `warn!` keeps it out of the
            // INFO firehose while still surfacing the failure in the
            // backend log. The frontend re-derives the same reason on
            // demand by calling `load_settings`.
            log::warn!("settings warm-up fell back to defaults: {reason}");
            s
        }
    };

    // Take the write lock just long enough to swap in the loaded value.
    // `RwLock::write` panics only on poisoning; treat poisoning as fatal
    // — the warm-up task is the first writer and a panic here would
    // already have aborted the bootstrap.
    {
        let mut guard = state
            .settings
            .write()
            .expect("AppState.settings RwLock poisoned during bootstrap");
        *guard = settings;
    }

    // Release the lock *before* flipping the readiness flag so a frontend
    // listener that races on `settings_ready` and immediately read-locks
    // `settings` cannot deadlock against this writer.
    state.settings_ready.store(true, Ordering::SeqCst);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The native file picker (Open File / Save As) is provided by
        // `tauri-plugin-dialog`. Registering it here exposes the plugin's
        // JS API to the frontend so `openFile()` / `saveFileAs()` can pick
        // a path before invoking `open_file` / `save_file`.
        .plugin(tauri_plugin_dialog::init())
        // `AppState::default()` seeds:
        //   - `settings`: `Settings::default()` (Req 10.4) — the warm-up
        //     task installed by the `setup` closure below overwrites this
        //     from disk.
        //   - `buffer_meta`: empty path → `BufferMeta` map.
        //   - `stream`: idle `StreamRegistry`.
        //   - `settings_ready`: `false`; flipped to `true` by the warm-up
        //     task once `Settings_Service::load` resolves.
        .manage(crate::state::AppState::default())
        // Req 15 surface plus the seventh internal `cancel_stream`
        // command (design "Keyboard handling": cooperative cancellation
        // entry point, Req 13.7). `cancel_stream` lives outside Req 15
        // because Req 15 specifies the minimum surface, not a maximum;
        // the frontend invokes it from the Escape-key handler.
        .invoke_handler(tauri::generate_handler![
            crate::commands::open_file,
            crate::commands::save_file,
            crate::commands::call_llm,
            crate::commands::stream_llm,
            crate::commands::cancel_stream,
            crate::commands::load_settings,
            crate::commands::save_settings,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Settings warm-up (Req 1.3, Req 1.6, Req 2.6).
            //
            // `AppState::default()` already left `settings_ready` at
            // `false`, so the AI menu items render disabled until this
            // task resolves. We resolve the disk read on Tokio's blocking
            // pool — `Settings_Service::load` is synchronous IO — and
            // hand the `LoadOutcome` to the pure `apply_load_outcome`
            // helper. Both arms (success and `DefaultsFromError`) flip
            // the flag to `true` so the frontend can enable the AI menu
            // even when the on-disk file is absent or corrupt
            // (Req 1.6 covers the fallback case explicitly).
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let outcome = match tauri::async_runtime::spawn_blocking(
                    crate::settings_service::load,
                )
                .await
                {
                    Ok(o) => o,
                    Err(join_err) => {
                        // A panic inside `Settings_Service::load` reaches
                        // us as a `JoinError`. Treat it as the same
                        // fall-back-to-defaults case that
                        // `DefaultsFromError` covers, so the AI menu
                        // still enables and the user can re-trigger a
                        // load by opening the Settings_Modal.
                        log::warn!(
                            "settings warm-up task panicked; using defaults: {join_err}"
                        );
                        LoadOutcome::DefaultsFromError(
                            crate::settings::Settings::default(),
                            format!("settings warm-up failed: {join_err}"),
                        )
                    }
                };

                let state = app_handle.state::<AppState>();
                apply_load_outcome(state.inner(), outcome);
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{ReplaceMode, Settings};
    use std::sync::atomic::Ordering;

    /// `LoadOutcome::Ok` overwrites the cache with the loaded value and
    /// flips `settings_ready` to `true`. This is the steady-state path
    /// taken on every launch after the first.
    #[test]
    fn apply_load_outcome_ok_writes_settings_and_marks_ready() {
        let state = AppState::default();
        assert!(!state.settings_ready.load(Ordering::SeqCst));

        let mut loaded = Settings::default();
        loaded.model = "loaded-from-disk".to_string();
        loaded.temperature = 1.25;
        loaded.replace_mode = ReplaceMode::ReplaceSelection;

        apply_load_outcome(&state, LoadOutcome::Ok(loaded.clone()));

        assert!(state.settings_ready.load(Ordering::SeqCst));
        let cached = state
            .settings
            .read()
            .expect("settings read lock")
            .clone();
        assert_eq!(cached, loaded);
    }

    /// `LoadOutcome::DefaultsCreated` is the first-launch path — the file
    /// did not exist, so `Settings_Service::load` wrote `Settings::default`
    /// to disk and handed back the same value. The cache must end up
    /// holding the defaults and the flag must flip.
    #[test]
    fn apply_load_outcome_defaults_created_marks_ready_with_defaults() {
        let state = AppState::default();

        apply_load_outcome(
            &state,
            LoadOutcome::DefaultsCreated(Settings::default()),
        );

        assert!(state.settings_ready.load(Ordering::SeqCst));
        let cached = state.settings.read().expect("read").clone();
        assert_eq!(cached, Settings::default());
    }

    /// `LoadOutcome::DefaultsFromError` is the fallback arm covered by
    /// Req 1.6 — even though the load surface produced a user-facing
    /// reason, the AI menu must still enable. The cache is overwritten
    /// with the defaults the outcome carries (which `Settings_Service`
    /// guarantees to be `Settings::default()`).
    #[test]
    fn apply_load_outcome_defaults_from_error_still_marks_ready() {
        let state = AppState::default();
        // Pre-stage a non-default value so the test detects the overwrite
        // even if the carried defaults happen to match the seed.
        {
            let mut guard = state.settings.write().expect("write");
            guard.model = "stale-from-pre-warmup".to_string();
        }

        apply_load_outcome(
            &state,
            LoadOutcome::DefaultsFromError(
                Settings::default(),
                "settings could not be loaded; using defaults: simulated".to_string(),
            ),
        );

        assert!(state.settings_ready.load(Ordering::SeqCst));
        let cached = state.settings.read().expect("read").clone();
        assert_eq!(cached, Settings::default());
    }

    /// `apply_load_outcome` is idempotent: calling it twice with two
    /// different outcomes leaves the cache holding the *second* value and
    /// the flag still set. Models the (admittedly hypothetical) case
    /// where a future feature reloads settings without restarting.
    #[test]
    fn apply_load_outcome_second_call_overwrites_first() {
        let state = AppState::default();

        let mut first = Settings::default();
        first.model = "first".to_string();
        apply_load_outcome(&state, LoadOutcome::Ok(first));

        let mut second = Settings::default();
        second.model = "second".to_string();
        apply_load_outcome(&state, LoadOutcome::Ok(second.clone()));

        assert!(state.settings_ready.load(Ordering::SeqCst));
        let cached = state.settings.read().expect("read").clone();
        assert_eq!(cached, second);
    }
}
