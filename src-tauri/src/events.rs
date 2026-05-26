// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — events.rs
//
// Backend → frontend custom events. The frontend listens for the three
// design-pinned event names (`tauri://file-opened`, `tauri://llm-token`,
// `tauri://llm-complete`); this module owns the constants and helpers that
// produce them so the literal strings live in exactly one place.
//
// Event-name choice: the design's data-flow diagram and the
// `events.test.js` outline both spell these names with the `tauri://`
// prefix. Tauri 2.x treats the `event` argument to `Emitter::emit` as an
// opaque string and validates it against `^[a-zA-Z0-9/:_-]+$` — the
// forward slash and colon are both members of the character class, so the
// design's verbatim names round-trip through the dispatcher unchanged.
// Centralizing them here means a future rename (should the prefix become a
// reserved namespace in a later Tauri release) is a single-line change in
// this file rather than a grep across the workspace.
//
// References:
// - Requirements:
//     13.1 — streaming task emits `tauri://llm-token` per fragment.
//     13.5 — terminal `tauri://llm-complete` carries the error reason.
//     14.6 — error reasons surface verbatim on `tauri://llm-complete`.
//     16.2 — `tauri://file-opened` payload is the loaded file's contents.
// - design.md:
//     "Data Flow" diagram (`emit file-opened`, `emit llm-token /
//     llm-complete`).
//     "Frontend tests" → `events.test.js`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

// -----------------------------------------------------------------------------
// File events
// -----------------------------------------------------------------------------

/// Event name pushed by `commands::open_file` (Task 11) once a file has
/// been read and its decoded `String` is ready for the editor (Req 16.2).
///
/// Kept verbatim from `design.md`'s data-flow diagram so the frontend
/// listener registration in `main.js` and the Vitest cases in
/// `events.test.js` can reference the same constant via Tauri's IPC.
pub const EVENT_FILE_OPENED: &str = "tauri://file-opened";

/// Push the loaded file's contents to every frontend listener registered
/// for `tauri://file-opened`.
///
/// Returns the underlying `tauri::Error` unchanged on failure so the caller
/// (the future `open_file` flow) can decide whether to surface the error
/// via the `Status_Bar` (Req 14.6) or log-and-continue. The current
/// `open_file` shim does not yet emit this event; Task 11 lands the wiring
/// once the stream-related events land alongside it.
///
/// `contents` is sent as the event payload exactly as received; the
/// frontend's `tauri://file-opened` handler is responsible for converting
/// the payload into a `String` and replacing the editor buffer (Req 4.4).
pub fn emit_file_opened(app: &AppHandle, contents: &str) -> Result<(), tauri::Error> {
    app.emit(EVENT_FILE_OPENED, contents)
}

// -----------------------------------------------------------------------------
// Streaming events (Task 15)
// -----------------------------------------------------------------------------

/// Event name pushed by `llm_client::start_stream` once per parsed token
/// fragment (Req 13.1). Payload is the fragment string, sent verbatim so
/// the frontend's `applyLLMResponse` can splice it into the buffer using
/// the active insertion mode without further processing.
pub const EVENT_LLM_TOKEN: &str = "tauri://llm-token";

/// Event name pushed during streaming agent turns when the model emits a
/// reasoning/thinking fragment (`delta.reasoning` or `delta.reasoning_content`).
pub const EVENT_LLM_REASONING_TOKEN: &str = "tauri://llm-reasoning-token";

/// Event name pushed by `llm_client::start_stream` exactly once per stream
/// — the terminal arm of the `tokio::select!` (Req 13.5). The payload is
/// `LlmCompletePayload`; on a clean completion (`[DONE]` or user cancel)
/// the `error` field is `None`, otherwise it carries the design-pinned
/// reason string (Req 14.1–14.5, 14.6).
pub const EVENT_LLM_COMPLETE: &str = "tauri://llm-complete";

/// Payload for `tauri://llm-complete`.
///
/// `error` is `None` on a clean completion and `Some(reason)` for every
/// failure arm. The frontend's listener distinguishes the two by simply
/// checking `evt.payload.error` — any non-null string surfaces in the
/// `Status_Bar` verbatim (Req 14.6). The struct is `serde::Serialize` so
/// `tauri::AppHandle::emit` can ship it as JSON; `Clone` is added because
/// a few unit tests below construct a payload, emit it, and re-inspect
/// the original.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct LlmCompletePayload {
    pub error: Option<String>,
}

/// Emit `tauri://llm-token` with `fragment` as the payload.
///
/// The fragment is sent as a JSON string (Tauri serializes the `&str`
/// argument with `serde_json`); the frontend listener's `evt.payload` is
/// therefore a plain string. Errors from `Emitter::emit` are propagated
/// to the caller; the streaming task logs them and keeps going so a
/// transient WebView dispatch failure does not abort the whole stream.
pub fn emit_llm_token(app: &AppHandle, fragment: &str) -> Result<(), tauri::Error> {
    app.emit(EVENT_LLM_TOKEN, fragment)
}

/// Emit `tauri://llm-reasoning-token` with `fragment` as the payload.
pub fn emit_llm_reasoning_token(app: &AppHandle, fragment: &str) -> Result<(), tauri::Error> {
    app.emit(EVENT_LLM_REASONING_TOKEN, fragment)
}

/// Emit `tauri://llm-complete` with the given `error` (or `None` for a
/// clean completion).
///
/// Constructs the payload struct inline so callers don't have to import
/// `LlmCompletePayload`. The terminal arm of the streaming task fires
/// this exactly once per stream (Req 13.5, 14.6).
pub fn emit_llm_complete(app: &AppHandle, error: Option<String>) -> Result<(), tauri::Error> {
    app.emit(EVENT_LLM_COMPLETE, LlmCompletePayload { error })
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// The event-name constant is the contract surface every test and
    /// frontend listener depends on; pin it here so an accidental edit
    /// trips a clear failure rather than a silent IPC mismatch at runtime.
    #[test]
    fn event_file_opened_matches_design_string() {
        assert_eq!(EVENT_FILE_OPENED, "tauri://file-opened");
    }

    /// Same contract surface as `EVENT_FILE_OPENED`, for the streaming
    /// per-token event. The frontend listener and the Vitest fixtures
    /// reference the literal string; pinning it here keeps them aligned.
    #[test]
    fn event_llm_token_matches_design_string() {
        assert_eq!(EVENT_LLM_TOKEN, "tauri://llm-token");
    }

    /// Terminal stream event. A typo here would silently break the
    /// `Status_Bar` error rendering path (Req 14.6).
    #[test]
    fn event_llm_complete_matches_design_string() {
        assert_eq!(EVENT_LLM_COMPLETE, "tauri://llm-complete");
    }

    /// Tauri 2.x validates event names against `^[a-zA-Z0-9/:_-]+$` before
    /// dispatching. Verifying every constant against the same character
    /// class here catches a future typo (e.g. an accidental space or `?`)
    /// at `cargo test` time rather than as a runtime
    /// `tauri::Error::EventName` the first time the helper is invoked.
    #[test]
    fn event_names_use_valid_event_name_chars() {
        for name in [
            EVENT_FILE_OPENED,
            EVENT_LLM_TOKEN,
            EVENT_LLM_REASONING_TOKEN,
            EVENT_LLM_COMPLETE,
        ] {
            for c in name.chars() {
                assert!(
                    c.is_ascii_alphanumeric() || matches!(c, '/' | ':' | '_' | '-'),
                    "event name {name:?} contains a character Tauri's dispatcher will reject: {c:?}"
                );
            }
        }
    }

    /// `LlmCompletePayload` round-trips through `serde_json` so the
    /// frontend listener observes the exact field shape it expects:
    /// `{ "error": null }` for a clean completion and `{ "error": "..." }`
    /// for every failure arm. Pinning the JSON shape with a literal
    /// comparison here catches a future `#[serde(rename = "...")]`
    /// regression that would silently break the frontend.
    #[test]
    fn llm_complete_payload_serializes_with_error_field() {
        let clean = LlmCompletePayload { error: None };
        let s = serde_json::to_string(&clean).expect("serialize clean payload");
        assert_eq!(s, r#"{"error":null}"#);

        let failed = LlmCompletePayload {
            error: Some("HTTP 503".to_string()),
        };
        let s = serde_json::to_string(&failed).expect("serialize failed payload");
        assert_eq!(s, r#"{"error":"HTTP 503"}"#);
    }
}
