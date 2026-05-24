// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — state.rs
//
// Backend application state held inside `tauri::State`. Three concerns live
// here:
//
//   1. `Settings` cache (Req 10.1, 15.5/15.6) — the in-memory copy of the
//      on-disk settings warmed up at startup and refreshed on every
//      successful `save_settings`. Wrapped in a `RwLock` so the streaming
//      task can grab a snapshot without contending with the (rare)
//      `save_settings` writer.
//
//   2. `BufferMeta` map (Req 4.6, 4.7, 5.3, 6.3, 6.5) — the per-path
//      bookkeeping that lets `save_file` round-trip the BOM and line-ending
//      preferences detected by `read_file`. The `open_file` command returns
//      only the decoded `String` to the frontend per Req 15.1; the metadata
//      lives here so the matching `save_file` can recover it without the
//      frontend having to shuttle it back.
//
//   3. `StreamRegistry` — a single-flight gate (Req 13.8, Req 15.8) for the
//      LLM streaming task. `try_acquire()` either installs a fresh
//      `CancellationToken` and returns it, or returns `AlreadyActive` so the
//      `stream_llm` command can short-circuit with the design's
//      `"a stream is already active"` error reason. `cancel()` (used by the
//      Escape-key path through the future `cancel_stream` command, Req 13.7)
//      fires the active token without removing the registry entry; the
//      streaming task itself calls `release()` after its terminal
//      `tauri://llm-complete` emit so the next Send to Model is accepted.
//
// `settings_ready` (Req 1.3, Req 1.6, Req 2.6) is an `AtomicBool` that flips
// from `false` to `true` once the bootstrap warm-up task in Task 12 finishes
// loading settings (success or `DefaultsFromError` — either way the cache is
// populated and the AI menu can enable). The frontend polls / `await`s
// `loadSettings()` and the bootstrap helper writes this flag; we put it on
// `AppState` so any future status surface can read it without taking the
// `RwLock`.
//
// References:
// - Requirements:
//     1.3 / 1.6 / 2.6 — AI menu disabled until settings warm-up resolves.
//     13.8           — at most one in-flight HTTP request per Stream.
//     15.8           — second `stream_llm` while active SHALL Err.
// - design.md:
//     "AppState" data model snippet.
//     "StreamRegistry / StreamHandle" snippet.
//     "Bootstrap" / "Settings warm-up" lifecycle bullets.
//
// Threading note: `RwLock<Settings>` uses `std::sync::RwLock`, not Tokio's
// async variant. The writer is invoked once on bootstrap and on every
// successful `save_settings` (a rare, user-initiated event); readers are
// cheap and synchronous. The async runtime is Tauri's, and command handlers
// can wrap any contended `read()` in `spawn_blocking` if a future workload
// ever demands it. The buffer-meta map and the stream registry are likewise
// `std::sync::Mutex`: held briefly, never across `.await`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, RwLock};

use tokio_util::sync::CancellationToken;

use crate::file_service::LineEnding;
use crate::settings::Settings;

// -----------------------------------------------------------------------------
// BufferMeta
// -----------------------------------------------------------------------------

/// Per-file bookkeeping cached at `open_file` time and consumed at
/// `save_file` time so the on-disk BOM and line-ending style survive a
/// round-trip without the frontend having to mirror them.
///
/// `had_bom` records the presence of a leading `EF BB BF` in the original
/// file (Req 4.6). `line_ending` records the *first* terminator encountered
/// during the read (Req 4.7); when no terminator was present the variant is
/// `LineEnding::None` and the write pipeline substitutes the OS default
/// (Req 6.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BufferMeta {
    /// `true` iff the file began with a UTF-8 BOM. Mirrored by `LoadedFile`.
    pub had_bom: bool,
    /// Line-terminator style recorded at read time. Mirrored by `LoadedFile`.
    pub line_ending: LineEnding,
}

// -----------------------------------------------------------------------------
// StreamHandle / AlreadyActive / StreamRegistry
// -----------------------------------------------------------------------------

/// Active-stream record held inside `StreamRegistry`.
///
/// The token is shared between the registry and the spawned streaming task
/// (the task holds a `clone()` to listen on, the registry holds the original
/// to fire on cancel). `CancellationToken::clone` is cheap — it bumps an
/// `Arc` refcount — so the duplication is intentional rather than incidental.
#[derive(Debug)]
pub struct StreamHandle {
    /// The token wired into the streaming task's `tokio::select!` arm.
    pub cancel: CancellationToken,
}

/// Returned by `StreamRegistry::try_acquire` when a stream is already
/// active. Carrying its own type (rather than a `()` or `bool`) keeps the
/// `Result<CancellationToken, AlreadyActive>` self-documenting and lets the
/// `stream_llm` command map it onto the design's
/// `"a stream is already active"` reason via a single `match` arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlreadyActive;

impl std::fmt::Display for AlreadyActive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a stream is already active")
    }
}

impl std::error::Error for AlreadyActive {}

/// Single-flight registry for the LLM streaming task.
///
/// The interior `Mutex<Option<StreamHandle>>` is the entire state: `Some`
/// means a stream is in flight, `None` means the next `stream_llm` is free
/// to proceed. Three operations:
///
/// - `try_acquire()` — `None` → install `Some(StreamHandle{ cancel })` and
///   return the token; `Some(_)` → `Err(AlreadyActive)`. Enforces
///   Req 13.8 / Req 15.8.
/// - `release()` — `Some(_)` → set to `None`. Called by the streaming task
///   *after* its terminal `tauri://llm-complete` emit so the next Send to
///   Model is accepted (per the "Backend error catalog" entry).
/// - `cancel()` — `Some(handle)` → fire `handle.cancel.cancel()`, leaving the
///   entry in place. Used by the Escape-key path so the streaming task
///   observes the cancellation through its own `tokio::select!` arm; the
///   registry slot is cleared by the subsequent `release()` from that task,
///   not by `cancel()` itself. This ordering guarantees that if a user
///   spam-presses Escape, every press sees `Some(_)` until the task
///   actually exits, and no second stream slips into the slot mid-cancel.
#[derive(Debug, Default)]
pub struct StreamRegistry(Mutex<Option<StreamHandle>>);

impl StreamRegistry {
    /// Construct an empty registry. Equivalent to `Default::default()` but
    /// retained as an explicit constructor for symmetry with other
    /// state-holding types in the backend.
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Attempt to claim the registry for a new stream.
    ///
    /// Returns the freshly-minted token on success. The returned token is a
    /// `clone()` of the one stored in the registry, so the caller can hand
    /// it directly to its `tokio::select!` arm without further bookkeeping.
    ///
    /// On `AlreadyActive`, the registry is left untouched and no token is
    /// produced. The `stream_llm` command propagates this as the
    /// `"a stream is already active"` reason mandated by the design's
    /// "Backend error catalog" (Req 13.8, Req 15.8).
    pub fn try_acquire(&self) -> Result<CancellationToken, AlreadyActive> {
        // `lock()` panics only on poisoning; treat poisoning as fatal — the
        // streaming task is the only writer and a panic there would already
        // have aborted the request. Recovering would mask a bug.
        let mut slot = self.0.lock().expect("StreamRegistry mutex poisoned");
        if slot.is_some() {
            return Err(AlreadyActive);
        }
        let token = CancellationToken::new();
        *slot = Some(StreamHandle {
            cancel: token.clone(),
        });
        Ok(token)
    }

    /// Release the registry slot.
    ///
    /// Idempotent: calling `release()` on an empty registry is a no-op so
    /// the streaming task does not have to track whether it already ran the
    /// terminal cleanup branch. The slot is cleared without firing the
    /// token (the caller is the task that *just* finished, so there is
    /// nothing to cancel).
    pub fn release(&self) {
        let mut slot = self.0.lock().expect("StreamRegistry mutex poisoned");
        *slot = None;
    }

    /// Fire the active stream's cancellation token without releasing the
    /// slot.
    ///
    /// `release()` is the streaming task's responsibility — it must run
    /// *after* the terminal `tauri://llm-complete` emit so Req 14.6's
    /// "Stream is no longer active" guarantee aligns with what the
    /// frontend observes. `cancel()` therefore only signals; it does not
    /// touch `*slot`.
    ///
    /// A no-op when the registry is empty (no stream is active), so the
    /// Escape-key handler can call this unconditionally without first
    /// querying the streaming state.
    pub fn cancel(&self) {
        let slot = self.0.lock().expect("StreamRegistry mutex poisoned");
        if let Some(handle) = slot.as_ref() {
            handle.cancel.cancel();
        }
    }
}

// -----------------------------------------------------------------------------
// AppState
// -----------------------------------------------------------------------------

/// The top-level `tauri::State` payload. Constructed once at app startup
/// (Task 11 will register it via `.manage(AppState::default())`) and shared
/// across every command invocation.
///
/// Field-by-field:
///
/// - `settings`: `RwLock<Settings>` — the cached settings struct. Populated
///   by the Task-12 bootstrap warm-up; refreshed on every successful
///   `save_settings`. Read by `load_settings`, `call_llm`, and the streaming
///   task; written only on `save_settings`. `RwLock` rather than `Mutex`
///   because the read/write ratio is heavily read-skewed.
///
/// - `buffer_meta`: `Mutex<HashMap<PathBuf, BufferMeta>>` — the per-path
///   BOM / line-ending cache. `Mutex` (not `RwLock`) because every access
///   is short and modifies the map (an `open_file` insert, a `save_file`
///   read-then-leave, or a Save-As migration), so a writer-lock-by-default
///   keeps the API simple.
///
/// - `stream`: `StreamRegistry` — the single-flight gate; see its own
///   docstring.
///
/// - `settings_ready`: `AtomicBool` — `false` from construction until the
///   warm-up task in Task 12 sets it to `true`. Frontend uses this to gate
///   the AI menu (Req 1.3, 1.6, 2.6). `Ordering::SeqCst` for both the
///   bootstrap store and any future read keeps reasoning straightforward;
///   the field is touched at most a handful of times in a session.
#[derive(Debug, Default)]
pub struct AppState {
    pub settings: RwLock<Settings>,
    pub buffer_meta: Mutex<HashMap<PathBuf, BufferMeta>>,
    pub stream: StreamRegistry,
    pub settings_ready: AtomicBool,
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    // ---- StreamRegistry ---------------------------------------------------

    #[test]
    fn try_acquire_succeeds_when_idle() {
        let reg = StreamRegistry::new();
        let token = reg.try_acquire().expect("idle registry must accept");
        // The freshly-issued token is not yet cancelled.
        assert!(!token.is_cancelled());
    }

    #[test]
    fn second_try_acquire_returns_already_active() {
        let reg = StreamRegistry::new();
        let _first = reg.try_acquire().expect("first try_acquire");
        let second = reg.try_acquire();
        assert!(matches!(second, Err(AlreadyActive)));
    }

    #[test]
    fn release_lets_a_subsequent_try_acquire_succeed() {
        let reg = StreamRegistry::new();
        let _first = reg.try_acquire().expect("first try_acquire");
        reg.release();
        let _second = reg
            .try_acquire()
            .expect("after release the registry must be free");
    }

    #[test]
    fn release_when_idle_is_a_no_op() {
        let reg = StreamRegistry::new();
        // Should not panic and leaves the registry idle.
        reg.release();
        let _t = reg.try_acquire().expect("registry must still be idle");
    }

    #[test]
    fn cancel_fires_active_token_without_releasing_slot() {
        let reg = StreamRegistry::new();
        let token = reg.try_acquire().expect("acquire");
        assert!(!token.is_cancelled());
        reg.cancel();
        // The token observed by the streaming task is now cancelled.
        assert!(token.is_cancelled());
        // Crucially, the slot is *still* occupied — only `release()` clears
        // it. The next `try_acquire` must therefore reject.
        assert!(matches!(reg.try_acquire(), Err(AlreadyActive)));
    }

    #[test]
    fn cancel_is_a_no_op_when_idle() {
        let reg = StreamRegistry::new();
        // No active stream; calling cancel must not panic.
        reg.cancel();
        // And the registry must still be acquirable.
        let _t = reg.try_acquire().expect("idle after cancel");
    }

    #[test]
    fn cancel_then_release_then_acquire_round_trip() {
        let reg = StreamRegistry::new();
        let token = reg.try_acquire().expect("acquire");
        reg.cancel();
        assert!(token.is_cancelled());
        // Streaming task observes cancellation and runs its terminal emit
        // followed by `release()`.
        reg.release();
        let next = reg.try_acquire().expect("acquire after release");
        assert!(!next.is_cancelled());
    }

    #[test]
    fn already_active_displays_the_design_string() {
        // The `stream_llm` command maps `AlreadyActive` onto this exact
        // string per the design's Backend error catalog.
        assert_eq!(AlreadyActive.to_string(), "a stream is already active");
    }

    // ---- AppState wiring --------------------------------------------------

    #[test]
    fn default_app_state_is_idle_and_not_ready() {
        let state = AppState::default();
        assert!(!state.settings_ready.load(Ordering::SeqCst));
        // Settings cache initializes to the Req 10.4 defaults.
        let snapshot = state.settings.read().expect("read settings").clone();
        assert_eq!(snapshot, Settings::default());
        // No buffer metadata yet.
        assert!(state
            .buffer_meta
            .lock()
            .expect("buffer_meta lock")
            .is_empty());
        // Stream registry is free.
        let _t = state
            .stream
            .try_acquire()
            .expect("fresh AppState must allow a stream");
    }

    #[test]
    fn buffer_meta_insert_and_get_round_trip() {
        let state = AppState::default();
        let path = PathBuf::from("/tmp/example.txt");
        let meta = BufferMeta {
            had_bom: true,
            line_ending: LineEnding::CrLf,
        };
        {
            let mut map = state.buffer_meta.lock().expect("lock");
            map.insert(path.clone(), meta);
        }
        let map = state.buffer_meta.lock().expect("lock");
        let got = map.get(&path).copied().expect("entry must be present");
        assert_eq!(got.had_bom, true);
        assert_eq!(got.line_ending, LineEnding::CrLf);
    }

    #[test]
    fn settings_ready_can_be_flipped_to_true() {
        // The Task-12 bootstrap helper writes this flag; mimic that here.
        let state = AppState::default();
        state.settings_ready.store(true, Ordering::SeqCst);
        assert!(state.settings_ready.load(Ordering::SeqCst));
    }
}
