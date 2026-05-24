// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — commands.rs
//
// Tauri command surface (Req 15). This module exposes the four file and
// settings commands that the frontend invokes plus the `validate_path`
// helper that gates every path-taking command:
//
//     fn validate_path(p: &str) -> Result<PathBuf, String>
//     async fn open_file(state, path) -> Result<String, String>
//     async fn save_file(state, path, contents) -> Result<(), String>
//     async fn load_settings(state) -> Result<Settings, String>
//     async fn save_settings(state, settings) -> Result<(), String>
//
// `call_llm` (Task 13) and `stream_llm` (Task 15) live in the same Req 15
// surface but are deliberately not implemented here; both will be added to
// this module without changing the four commands above.
//
// Centralizing `validate_path` means `open_file` and `save_file` cannot
// drift apart on what counts as a valid path; the rules and exact error
// messages come from design.md (the "Path validation (Req 15.7)" snippet)
// and the "Backend error catalog".
//
// The three rejection reasons are reused from `crate::error::FileError`
// (`PathEmpty`, `PathNullByte`, `PathNotAbsolute`) so the strings the user
// sees on a bad `open_file`/`save_file` call match the strings the
// `File_Service` would produce for the same condition. If the FileError
// Display strings ever change, this helper changes with them automatically.
//
// Threading model:
// - `read_file` / `write_file` / `settings_service::save` are blocking
//   filesystem calls. Each command wraps them in `tokio::task::spawn_blocking`
//   so the Tauri runtime stays responsive while the kernel does its work.
//   A `JoinError` from `spawn_blocking` only fires on panic / cancellation;
//   we surface it as a generic background-task failure rather than mapping
//   it to a layer-specific catalog string.
// - `state.buffer_meta` is a `std::sync::Mutex`; we hold the lock only long
//   enough to read or insert a single entry and never across `.await`.
// - `state.settings` is a `std::sync::RwLock`; `load_settings` takes a
//   read-lock long enough to clone, `save_settings` takes a write-lock
//   only after the on-disk persist succeeds so a failed write leaves the
//   in-memory cache consistent with disk (Req 11.9).
//
// References:
// - Requirements:
//     15.1 — open_file Result<String, String>
//     15.2 — save_file Result<(), String>, no partially written file
//     15.5 — load_settings Result<Settings, String>
//     15.6 — save_settings Result<(), String>
//     15.7 — validate_path on every path argument
//     4.4  — Open File replaces Buffer on success
//     4.8  — invalid UTF-8 surfaces "file is not valid UTF-8"
//     4.9  — read IO failure surfaces "could not read file: ..."
//     5.5  — save failure leaves the file unchanged
//     6.4  — Save As writes via save_file with the new path
//     6.5  — Save As without recorded prefs uses OS defaults
//     6.6  — Save As failure leaves the file unchanged
//     9.5  — Settings_Modal Save persists Settings via save_settings
// - design.md: "commands.rs (the Req 15 surface)" and "Path validation".

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::error::{FileError, LlmError};
use crate::file_service::{self, LineEnding};
use crate::llm_client;
use crate::settings::Settings;
use crate::settings_service;
use crate::state::{AppState, BufferMeta};

/// Validate a frontend-supplied path string before any filesystem work.
///
/// Per Req 15.7 and the design's `validate_path` snippet, the function
/// rejects, in this order:
///
/// 1. The empty string                  → `"path is empty"`
/// 2. A path containing a NUL byte      → `"path contains null byte"`
/// 3. A non-absolute path               → `"path is not absolute"`
///
/// On success the input is returned as a `PathBuf`. The error strings are
/// produced by `FileError`'s `Display` impl (and its `From<FileError> for
/// String` conversion) so the wording stays in lockstep with the rest of
/// the File_Service's error surface.
pub fn validate_path(p: &str) -> Result<PathBuf, String> {
    if p.is_empty() {
        return Err(FileError::PathEmpty.into());
    }
    if p.contains('\0') {
        return Err(FileError::PathNullByte.into());
    }
    let pb = PathBuf::from(p);
    if !pb.is_absolute() {
        return Err(FileError::PathNotAbsolute.into());
    }
    Ok(pb)
}

// -----------------------------------------------------------------------------
// BufferMeta resolution helper
// -----------------------------------------------------------------------------

/// Resolve the `BufferMeta` to use when writing `path`.
///
/// The lookup is path-keyed: if the frontend previously opened the file via
/// `open_file`, the matching `BufferMeta` was cached at that time and is
/// returned verbatim (Req 5.3, 6.3). Otherwise — Save As to a fresh path or
/// a Save against a buffer the backend never tracked — the OS-default
/// fallback applies: no BOM and `LineEnding::None` so `file_service::write_file`
/// substitutes the platform-appropriate terminator (Req 6.5).
///
/// Pulled out of `save_file` as a pure function so it has a single call
/// shape and a name that documents the fallback rule. The `&HashMap` borrow
/// is short and synchronous; callers hold the `Mutex` across this call only
/// while computing the metadata, never across `.await`.
fn resolve_buffer_meta(meta_map: &HashMap<PathBuf, BufferMeta>, path: &Path) -> BufferMeta {
    meta_map
        .get(path)
        .copied()
        .unwrap_or(BufferMeta {
            had_bom: false,
            line_ending: LineEnding::None,
        })
}

// -----------------------------------------------------------------------------
// open_file (Req 15.1, 4.4, 4.8, 4.9)
// -----------------------------------------------------------------------------

/// Read the file at `path` and return its UTF-8 contents to the frontend.
///
/// Pipeline:
///
/// 1. `validate_path(&path)` — empty / null-byte / non-absolute paths are
///    rejected with the design's catalog strings before any I/O (Req 15.7).
/// 2. `file_service::read_file(&pb)` — runs on a `spawn_blocking` worker so
///    the Tauri runtime keeps servicing other commands while the kernel
///    does the read (Req 4.5–4.9). Errors are mapped to their catalog
///    strings via `FileError`'s `Display` impl: `"file is not valid UTF-8"`
///    on encoding failure (Req 4.8) or `"could not read file: {os_error}"`
///    on IO failure (Req 4.9).
/// 3. On success, the resulting `(had_bom, line_ending)` pair is cached in
///    `state.buffer_meta` keyed by the absolute path so the matching
///    `save_file` can round-trip the BOM and line-ending preferences
///    without the frontend having to mirror them (Req 4.6, 4.7, 5.3).
/// 4. Only the decoded `String` is returned to the frontend (Req 15.1).
#[tauri::command]
pub async fn open_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    // Step 1: validate. The helper returns the design's catalog strings
    // verbatim ("path is empty" / "path contains null byte" /
    // "path is not absolute"), so a `?` here propagates them unchanged.
    let pb = validate_path(&path)?;

    // Step 2: blocking read on a worker thread. `spawn_blocking` returns a
    // `JoinHandle<Result<LoadedFile, FileError>>`; awaiting yields a
    // `Result<Result<LoadedFile, FileError>, JoinError>`. The outer arm only
    // fires on a panic in the closure or runtime shutdown — neither of
    // which is a documented `FileError` — so we surface it as a generic
    // background-task failure rather than fabricating a catalog string.
    let pb_for_read = pb.clone();
    let loaded = tokio::task::spawn_blocking(move || file_service::read_file(&pb_for_read))
        .await
        .map_err(|e| format!("background task failed: {e}"))?
        .map_err(<FileError as Into<String>>::into)?;

    // Step 3: cache the per-path BOM / line-ending preferences for the
    // matching `save_file`. The lock is held only long enough to insert.
    {
        let mut map = state
            .buffer_meta
            .lock()
            .expect("buffer_meta mutex poisoned");
        map.insert(
            pb,
            BufferMeta {
                had_bom: loaded.had_bom,
                line_ending: loaded.line_ending,
            },
        );
    }

    // Step 4: decoded contents only (Req 15.1).
    Ok(loaded.contents)
}

// -----------------------------------------------------------------------------
// save_file (Req 15.2, 5.5, 6.4, 6.5, 6.6)
// -----------------------------------------------------------------------------

/// Persist `contents` to `path` using the cached per-path BOM and
/// line-ending preferences, falling back to OS defaults when none are
/// recorded.
///
/// Pipeline:
///
/// 1. `validate_path(&path)` — same rules as `open_file` (Req 15.7).
/// 2. Resolve the `BufferMeta` for `path` from `state.buffer_meta`.
///    A hit means the file was previously opened by `open_file`; a miss
///    means this is a Save As to a fresh path (or a Save against a buffer
///    the backend never tracked), in which case we fall back to no BOM and
///    `LineEnding::None` so `file_service::write_file` substitutes the
///    platform terminator per Req 6.5.
/// 3. `file_service::write_file` runs on `spawn_blocking`; its atomic
///    temp+fsync+rename pattern guarantees Req 5.5 / 6.6 — a failed write
///    leaves the destination unchanged.
/// 4. On success we ensure the `BufferMeta` map has an entry at `path`.
///    For a fresh Save As destination this installs the fallback metadata
///    we just used so a follow-up Save reuses it; for an already-tracked
///    path the `insert` is a no-op overwrite of identical data.
#[tauri::command]
pub async fn save_file(
    state: State<'_, AppState>,
    path: String,
    contents: String,
) -> Result<(), String> {
    // Step 1: validate.
    let pb = validate_path(&path)?;

    // Step 2: resolve metadata. Lock is dropped before the `.await` below.
    let meta = {
        let map = state
            .buffer_meta
            .lock()
            .expect("buffer_meta mutex poisoned");
        resolve_buffer_meta(&map, &pb)
    };

    // Step 3: blocking atomic write on a worker thread.
    let pb_for_write = pb.clone();
    tokio::task::spawn_blocking(move || {
        file_service::write_file(&pb_for_write, &contents, meta.had_bom, meta.line_ending)
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
    .map_err(<FileError as Into<String>>::into)?;

    // Step 4: ensure the cache reflects the write. `insert` overwrites any
    // existing entry with identical content (the cache is path-keyed and
    // we just used `meta` for the write), so this branch is the Save-As
    // migration path: the new path key now holds the active buffer's
    // metadata and a follow-up Save against the same path round-trips
    // correctly.
    {
        let mut map = state
            .buffer_meta
            .lock()
            .expect("buffer_meta mutex poisoned");
        map.insert(pb, meta);
    }

    Ok(())
}

// -----------------------------------------------------------------------------
// call_llm (Req 15.3, 14.1, 14.3, 14.4, 14.5)
// -----------------------------------------------------------------------------

/// Send `text` to the LM Studio endpoint as a non-streaming chat-completions
/// request and return the first choice's `message.content`.
///
/// The command is a thin adapter over `llm_client::call_blocking`: the
/// frontend supplies the resolved user-message text (selection vs. full
/// buffer is decided in `editor.js` per Req 12.1, 12.2) and the current
/// `Settings` snapshot (the same one returned by `load_settings`), and the
/// `LlmError` returned by `call_blocking` is mapped onto the `String` that
/// Tauri serializes back across the IPC boundary via the existing
/// `From<LlmError> for String` impl in `error.rs`.
///
/// The frontend reads the cached `Settings` from `loadSettings()` and
/// passes the snapshot in. This matches design.md's pinned signature for
/// `call_llm(text, settings)`; an alternative shape that read the cache
/// from `AppState` would also work but is not what the design specifies,
/// so we keep the explicit `settings` parameter so the public Tauri
/// surface in `lib.rs`, the JS `api.js` wrapper, and the design doc all
/// agree.
#[tauri::command]
pub async fn call_llm(text: String, settings: Settings) -> Result<String, String> {
    llm_client::call_blocking(&text, &settings)
        .await
        .map_err(<LlmError as Into<String>>::into)
}

// -----------------------------------------------------------------------------
// agent_turn (tool use, non-streaming agent loop)
// -----------------------------------------------------------------------------

/// Run one non-streaming chat turn with editor tool definitions attached.
///
/// The frontend owns the multi-turn agent loop: it sends the full
/// `messages` array (system, user, assistant tool_calls, tool results),
/// receives `AgentTurnResponse`, executes any requested tools locally,
/// appends tool results, and calls this command again until the model
/// stops requesting tools.
#[tauri::command]
pub async fn agent_turn(
    messages: Vec<serde_json::Value>,
    settings: Settings,
) -> Result<llm_client::AgentTurnResponse, String> {
    llm_client::agent_turn(messages, &settings)
        .await
        .map_err(<LlmError as Into<String>>::into)
}

// -----------------------------------------------------------------------------
// stream_llm (Req 15.4, 15.8, 13.1, 13.5, 13.7, 13.8, 14.1–14.7)
// -----------------------------------------------------------------------------

/// Begin a streaming LLM request and return immediately so the frontend
/// can disable the buffer and start listening for `tauri://llm-token` /
/// `tauri://llm-complete` events without blocking.
///
/// Pipeline:
///
///   1. `state.stream.try_acquire()` enforces the single-flight rule
///      (Req 13.8, 15.8). On `AlreadyActive` we return the design's
///      catalog string `"a stream is already active"` immediately, with
///      no token spawned and no events emitted (the frontend's
///      Status_Bar handler shows the reason verbatim per Req 14.6, and
///      Req 12.7 may also short-circuit before reaching this command).
///
///   2. `tokio::spawn` the streaming worker. The spawned future owns the
///      `text`, `settings`, and `CancellationToken`; `start_stream`
///      returns only after the terminal `tauri://llm-complete` emit and
///      the `StreamRegistry::release()` call inside its `ReleaseOnDrop`
///      guard, so the registry slot is always cleared before the next
///      Send to Model is accepted.
///
///   3. Resolve `Ok(())` synchronously (Req 15.4). The work happens on
///      the spawned task; the command itself is a tiny `acquire +
///      spawn + return` adapter that completes in well under the 200ms
///      budget on every reasonable host.
///
/// Note that `state.stream.cancel()` is invoked through the separate
/// `cancel_stream` command below — this command never fires the token
/// itself.
#[tauri::command]
pub async fn stream_llm(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    settings: Settings,
) -> Result<(), String> {
    // Step 1: single-flight gate.
    let cancel = state
        .stream
        .try_acquire()
        .map_err(|e| e.to_string())?;

    // Step 2: hand off to the worker. `tokio::spawn` returns immediately;
    // the spawned future holds an `AppHandle` clone (cheap — `AppHandle`
    // is internally `Arc`-shared) so it can both emit events and recover
    // the managed `AppState` for the registry release.
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        llm_client::start_stream(app_for_task, text, settings, cancel).await;
    });

    // Step 3: immediate Ok per Req 15.4.
    Ok(())
}

// -----------------------------------------------------------------------------
// cancel_stream (Req 13.7) — internal seventh command, not in Req 15
// -----------------------------------------------------------------------------

/// Fire the active stream's cancellation token without releasing the
/// registry slot.
///
/// This is the seventh command beyond Req 15's six-command minimum
/// surface; the design's "Keyboard handling" section pins it as the
/// cooperative cancellation entry point invoked by the frontend's Escape
/// handler (Req 13.7). The actual `tauri://llm-complete` emit happens
/// inside `start_stream`'s `tokio::select!` arm — this command only
/// signals; the streaming task runs the terminal emit and then the
/// `ReleaseOnDrop` guard clears the registry slot.
///
/// `state.stream.cancel()` is a no-op when the registry is empty, so the
/// frontend can call this unconditionally on Escape without first
/// querying whether a stream is active.
#[tauri::command]
pub async fn cancel_stream(state: State<'_, AppState>) -> Result<(), String> {
    state.stream.cancel();
    Ok(())
}

// -----------------------------------------------------------------------------
// load_settings (Req 15.5)
// -----------------------------------------------------------------------------

/// Return a clone of the cached `Settings`.
///
/// The cache is populated by the bootstrap warm-up (Task 12) and refreshed
/// on every successful `save_settings`; reading it here is a synchronous
/// `RwLock::read` followed by a `Clone`. Even though the read does not
/// `.await`, the command is `async` because the Tauri command macro
/// requires `async` for state-bearing handlers.
///
/// This command never returns `Err`. The `Result` shape is dictated by
/// Req 15.5; in practice the underlying `RwLock` only fails on poisoning,
/// which is a panic-only condition. A poisoned lock indicates a backend bug
/// rather than a user-facing failure, so we propagate the panic via
/// `expect` rather than fabricating a catalog string for it.
#[tauri::command]
pub async fn load_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let snapshot = state
        .settings
        .read()
        .expect("settings RwLock poisoned")
        .clone();
    Ok(snapshot)
}

// -----------------------------------------------------------------------------
// save_settings (Req 15.6, 9.5, 11.9)
// -----------------------------------------------------------------------------

/// Validate `settings`, persist them to disk, and refresh the in-memory
/// cache.
///
/// Pipeline:
///
/// 1. `Settings::validate` — every Req 10.2 / 10.3 bound is checked first
///    so an invalid struct never reaches the disk. The full `Vec<FieldError>`
///    is collapsed into a single semicolon-separated string so the
///    Settings_Modal can render every offender at once (Req 11.4–11.7).
///    The `"settings invalid: "` prefix follows the design's catalog
///    convention for validation surfaces.
/// 2. `settings_service::save` — runs on `spawn_blocking`. Errors map to
///    `"settings could not be saved: {os_error}"` via `SettingsError`'s
///    `Display` impl (Req 11.9). On failure the on-disk file and the
///    in-memory cache are both untouched (Req 10.7).
/// 3. On success the `RwLock<Settings>` cache is overwritten with the new
///    value so a follow-up `load_settings` returns the persisted state
///    without re-reading the file.
#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    // Step 1: validate up-front. Collapse every offender into one line so
    // the Settings_Modal can show the full picture; Req 11.4–11.7 want
    // per-field messages, but at the command boundary we only expose a
    // single `String` and the modal parses it back out.
    if let Err(errors) = settings.validate() {
        let joined = errors
            .iter()
            .map(|e| format!("{}: {}", e.field, e.reason))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("settings invalid: {joined}"));
    }

    // Step 2: persist on a worker thread. Clone for the blocking closure;
    // the original `settings` lives on for the cache update below.
    let to_save = settings.clone();
    tokio::task::spawn_blocking(move || settings_service::save(&to_save))
        .await
        .map_err(|e| format!("background task failed: {e}"))?
        .map_err(<crate::error::SettingsError as Into<String>>::into)?;

    // Step 3: refresh the in-memory cache only after the disk write
    // succeeded so a failed save does not leave the cache out of sync
    // with the file (Req 10.7, 11.9).
    {
        let mut guard = state
            .settings
            .write()
            .expect("settings RwLock poisoned");
        *guard = settings;
    }

    Ok(())
}

// -----------------------------------------------------------------------------
// list_models — fetch available models from LM Studio
// -----------------------------------------------------------------------------

/// Fetch the list of loaded model IDs from an LM Studio (or compatible)
/// server. Tries the OpenAI-compatible `/v1/models` endpoint first (which
/// only returns loaded models), then falls back to `/api/v1/models`.
///
/// This command runs the HTTP request from the Rust backend using `reqwest`,
/// bypassing any CORS restrictions that would block a direct `fetch()` from
/// the Tauri webview.
#[tauri::command]
pub async fn list_models(api_url: String) -> Result<Vec<String>, String> {
    list_models_impl(&api_url).await.map_err(|e| e.to_string())
}

/// Internal implementation for `list_models`.
async fn list_models_impl(api_url: &str) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let trimmed = api_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("API URL is required".into());
    }

    // Derive the base URL by stripping known suffixes.
    let base = if trimmed.ends_with("/api/v1/chat/completions") {
        &trimmed[..trimmed.len() - "/api/v1/chat/completions".len()]
    } else if trimmed.ends_with("/v1/chat/completions") {
        &trimmed[..trimmed.len() - "/v1/chat/completions".len()]
    } else if trimmed.ends_with("/api/v1") {
        &trimmed[..trimmed.len() - "/api/v1".len()]
    } else if trimmed.ends_with("/v1") {
        &trimmed[..trimmed.len() - "/v1".len()]
    } else {
        trimmed
    };

    let legacy_url = format!("{base}/v1/models");
    let primary_url = format!("{base}/api/v1/models");
    let client = crate::llm_client::http_client_ref();
    let timeout = std::time::Duration::from_secs(10);

    // Prefer /v1/models (only loaded models) over /api/v1/models (all downloaded).
    if legacy_url != primary_url {
        if let Ok(ids) = fetch_and_parse_models(client, &legacy_url, timeout).await {
            if !ids.is_empty() {
                return Ok(ids);
            }
        }
    }

    let ids = fetch_and_parse_models(client, &primary_url, timeout).await?;
    if ids.is_empty() {
        return Err("server returned no models (load a model in LM Studio first)".into());
    }
    Ok(ids)
}

/// Fetch models from a URL and parse the response.
async fn fetch_and_parse_models(
    client: &reqwest::Client,
    url: &str,
    timeout: std::time::Duration,
) -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let res = client
        .get(url)
        .timeout(timeout)
        .header("Accept", "application/json")
        .send()
        .await?;

    if !res.status().is_success() {
        return Err(format!("models request failed: HTTP {}", res.status().as_u16()).into());
    }

    let body: serde_json::Value = res.json().await?;

    // Support both OpenAI-compatible format ({ data: [...] }) and
    // LM Studio's native REST format ({ models: [...] }).
    let entries = if let Some(arr) = body.get("data").and_then(|v| v.as_array()) {
        arr.clone()
    } else if let Some(arr) = body.get("models").and_then(|v| v.as_array()) {
        arr.clone()
    } else {
        return Ok(Vec::new());
    };

    let mut ids: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for entry in &entries {
        let id = if let Some(s) = entry.get("id").and_then(|v| v.as_str()) {
            s.trim().to_string()
        } else if let Some(s) = entry.get("key").and_then(|v| v.as_str()) {
            s.trim().to_string()
        } else if let Some(s) = entry.get("path").and_then(|v| v.as_str()) {
            s.trim().to_string()
        } else {
            continue;
        };

        if id.is_empty() || seen.contains(&id) {
            continue;
        }
        seen.insert(id.clone());
        ids.push(id);
    }

    ids.sort();
    Ok(ids)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_service::LineEnding;

    // ---- validate_path ----------------------------------------------------

    #[test]
    fn empty_path_is_rejected_with_design_message() {
        let err = validate_path("").unwrap_err();
        assert_eq!(err, "path is empty");
    }

    #[test]
    fn null_byte_path_is_rejected_with_design_message() {
        // NUL anywhere in the string is rejected; the absolute-prefix check
        // never runs because the null-byte branch fires first.
        let err = validate_path("/tmp/with\0null").unwrap_err();
        assert_eq!(err, "path contains null byte");

        // Even a path that would otherwise be relative is reported as a
        // null-byte error, confirming the documented short-circuit order
        // (empty → null byte → absolute).
        let err = validate_path("rel\0ative").unwrap_err();
        assert_eq!(err, "path contains null byte");
    }

    #[test]
    fn relative_path_is_rejected_with_design_message() {
        let err = validate_path("relative/path.txt").unwrap_err();
        assert_eq!(err, "path is not absolute");
    }

    #[test]
    fn valid_absolute_path_is_accepted() {
        // Use a platform-appropriate absolute path so the test passes on
        // both macOS and Windows runners.
        #[cfg(unix)]
        let input = "/tmp/llimedit/example.txt";
        #[cfg(windows)]
        let input = r"C:\Users\example\file.txt";

        let pb = validate_path(input).expect("absolute path should validate");
        assert_eq!(pb, PathBuf::from(input));
        assert!(pb.is_absolute());
    }

    // ---- resolve_buffer_meta ---------------------------------------------

    #[test]
    fn resolve_buffer_meta_returns_cached_entry_when_present() {
        // A path the frontend previously opened: the recorded BOM and
        // line-ending preferences must come back verbatim so the matching
        // `save_file` round-trips them (Req 5.3, 6.3).
        let mut map: HashMap<PathBuf, BufferMeta> = HashMap::new();
        let path = PathBuf::from("/tmp/example.txt");
        let cached = BufferMeta {
            had_bom: true,
            line_ending: LineEnding::CrLf,
        };
        map.insert(path.clone(), cached);

        let resolved = resolve_buffer_meta(&map, &path);
        assert_eq!(resolved.had_bom, true);
        assert_eq!(resolved.line_ending, LineEnding::CrLf);
    }

    #[test]
    fn resolve_buffer_meta_falls_back_to_os_defaults_when_absent() {
        // A Save As to a path the backend never tracked must fall back to
        // no BOM and `LineEnding::None` so `file_service::write_file`
        // substitutes the platform terminator (Req 6.5).
        let map: HashMap<PathBuf, BufferMeta> = HashMap::new();
        let path = PathBuf::from("/tmp/never-opened.txt");

        let resolved = resolve_buffer_meta(&map, &path);
        assert_eq!(resolved.had_bom, false);
        assert_eq!(resolved.line_ending, LineEnding::None);
    }

    #[test]
    fn resolve_buffer_meta_uses_path_as_key_not_filename() {
        // Two files with the same `file_name` but different parents must
        // resolve independently. This pins the cache as path-keyed rather
        // than name-keyed.
        let mut map: HashMap<PathBuf, BufferMeta> = HashMap::new();
        let a = PathBuf::from("/tmp/dir-a/file.txt");
        let b = PathBuf::from("/tmp/dir-b/file.txt");
        map.insert(
            a.clone(),
            BufferMeta {
                had_bom: true,
                line_ending: LineEnding::Lf,
            },
        );

        let ra = resolve_buffer_meta(&map, &a);
        let rb = resolve_buffer_meta(&map, &b);
        assert_eq!(ra.had_bom, true);
        assert_eq!(ra.line_ending, LineEnding::Lf);
        // `b` has no entry, so the fallback applies.
        assert_eq!(rb.had_bom, false);
        assert_eq!(rb.line_ending, LineEnding::None);
    }
}
