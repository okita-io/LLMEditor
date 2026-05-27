// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — api.js
//
// Thin wrappers around `__TAURI__.core.invoke` for every Req 15 command
// plus the seventh internal `cancel_stream` command. Each wrapper awaits
// the underlying invoke and returns its resolved value verbatim, so
// callers in `editor.js`, `settings_modal.js`, and `main.js` see exactly
// the `Result<T, String>` shape the Rust layer produces. Errors propagate
// as rejected promises with the catalog string from `error.rs` as the
// `Error.message`.
//
// Why a thin shim:
//   - The Rust command surface is fixed (Req 15) and the Insertion_Mode /
//     Settings shapes the frontend ships across the bridge are pinned
//     elsewhere (Req 10, Req 13, Req 16). Centralizing the invoke calls
//     here keeps the rest of the frontend free of `window.__TAURI__`
//     references and gives tests a single seam to mock.
//   - There is no bundler. We rely on the Tauri 2 `withGlobalTauri`
//     option (set in `tauri-conf.json`) to expose `window.__TAURI__` so
//     ES modules loaded directly by the WebView can reach the IPC API
//     without `import` statements that would require resolution.
//   - The lookup is deferred to call time. That way Vitest+jsdom tests
//     can assign `window.__TAURI__ = { core: { invoke: ... } }` before
//     each test without racing module evaluation.
//
// Argument naming follows Tauri 2's convention: JS sends camelCase keys
// and the Rust `#[tauri::command]` macro converts them to snake_case
// parameters. Every Rust parameter we hit here is a single word
// (`path`, `contents`, `text`, `settings`), so the JS and Rust spellings
// happen to be identical; the wrappers still pass arguments by name so
// that future multi-word parameters can be added without touching the
// call sites.
//
// References:
// - design.md: "api.js — thin invoke() wrappers for each Tauri command".
// - Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 13.7,
//                 16.1, 16.2.

/**
 * Resolve the Tauri `invoke` function from the global object.
 *
 * Looking it up at call time (rather than at module-load time) lets
 * Vitest tests inject a stub onto `window.__TAURI__` per test without
 * having to monkey-patch the api.js exports themselves. In production the
 * global is set by Tauri's `withGlobalTauri` option before any frontend
 * script runs, so the lookup always succeeds the first time it is hit.
 *
 * @returns {(cmd: string, args?: Record<string, unknown>) => Promise<unknown>}
 */
function getInvoke() {
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
    throw new Error("Tauri IPC bridge unavailable (window.__TAURI__.core.invoke missing)");
  }
  return tauri.core.invoke;
}

/**
 * Read the file at `path` from disk.
 *
 * Maps to the `open_file` Tauri command (Req 15.1). On success the
 * resolved value is the UTF-8 decoded contents; on failure the rejection
 * carries the catalog string produced by `error.rs` (e.g.
 * `"path is empty"`, `"file is not valid UTF-8"`,
 * `"could not read file: {os_error}"`).
 *
 * @param {string} path Absolute path to the file to read.
 * @returns {Promise<string>}
 */
export async function openFile(path) {
  return await getInvoke()("open_file", { path });
}

/**
 * Persist `contents` to `path` using the cached BOM and line-ending
 * preferences for that path (Req 15.2, 5.3, 5.5, 6.3, 6.5, 6.6).
 *
 * @param {string} path     Absolute destination path.
 * @param {string} contents Buffer text to write.
 * @returns {Promise<void>}
 */
export async function saveFile(path, contents) {
  return await getInvoke()("save_file", { path, contents });
}

/**
 * Send `text` to the LM Studio endpoint as a non-streaming request and
 * resolve to the assistant's full reply (Req 15.3, 12.1, 12.2, 12.4,
 * 12.5). The catalog strings from `LlmError` (`"connection failed"`,
 * `"invalid response"`, `"HTTP {status}"`, `"connection lost"`) surface
 * as rejection reasons.
 *
 * @param {string} text     Resolved user-message content (selection or
 *                          full buffer; the choice is made in editor.js
 *                          per Req 12.1, 12.2).
 * @param {object} settings Current settings snapshot.
 * @returns {Promise<string>}
 */
export async function callLlm(text, settings) {
  return await getInvoke()("call_llm", { text, settings });
}

/**
 * Begin a streaming LLM request (Req 15.4, 13.1, 13.8, 15.8). Resolves
 * within ~200ms after the spawned worker is registered with the
 * single-flight `StreamRegistry`; the actual tokens arrive as
 * `tauri://llm-token` events and the terminal arm as
 * `tauri://llm-complete`. A second concurrent call rejects with
 * `"a stream is already active"`.
 *
 * @param {string} text
 * @param {object} settings
 * @returns {Promise<void>}
 */
export async function streamLlm(text, settings) {
  return await getInvoke()("stream_llm", { text, settings });
}

/**
 * Run one non-streaming agent turn with editor tools enabled.
 *
 * @param {Array<Record<string, unknown>>} messages Conversation history.
 * @param {object} settings Current settings snapshot.
 * @returns {Promise<{ content?: string|null, tool_calls: Array<{ id: string, name: string, arguments: string }>, finish_reason?: string|null, reasoning?: string|null }>}
 */
export async function agentTurn(messages, settings, customTools = []) {
  return await getInvoke()("agent_turn", {
    messages,
    settings,
    customTools,
  });
}

/**
 * Delete the file at `path` from disk.
 *
 * @param {string} path Absolute path to delete.
 * @returns {Promise<void>}
 */
export async function deleteFile(path) {
  return await getInvoke()("delete_file", { path });
}

/**
 * Fire the active stream's cancellation token (Req 13.7). No-op when no
 * stream is active, so the frontend's Escape handler can call this
 * unconditionally. Resolves once the backend has signalled the token —
 * the `tauri://llm-complete` emit follows from inside the streaming
 * worker.
 *
 * @returns {Promise<void>}
 */
export async function cancelStream() {
  return await getInvoke()("cancel_stream");
}

/**
 * Return the cached `Settings` snapshot from the backend (Req 15.5).
 * The bootstrap warm-up populates this cache before the AI menu is
 * enabled (Req 1.3, 1.6).
 *
 * @returns {Promise<object>}
 */
export async function loadSettings() {
  return await getInvoke()("load_settings");
}

/**
 * Validate `settings`, persist them atomically, and update the in-memory
 * cache (Req 15.6, 9.5, 11.9). On validation failure the rejection
 * reason starts with `"settings invalid: "` followed by per-field
 * messages.
 *
 * @param {object} settings
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  return await getInvoke()("save_settings", { settings });
}

/**
 * Fetch the list of loaded model IDs from an LM Studio (or compatible)
 * server via the Rust backend. This avoids CORS issues that would block
 * a direct `fetch()` from the Tauri webview.
 *
 * @param {string} apiUrl Chat completions URL or server base URL.
 * @returns {Promise<string[]>}
 */
export async function listModels(apiUrl) {
  return await getInvoke()("list_models", { apiUrl });
}

/**
 * @typedef {{
 *   id: string,
 *   loaded: boolean,
 *   capabilities: {
 *     vision: boolean,
 *     tool_use: boolean,
 *     reasoning: { allowed_options: string[], default: string | null } | null,
 *   },
 * }} ModelInfo
 */

/**
 * Fetch detailed model metadata (capabilities, loaded state) from LM
 * Studio's native `/api/v1/models` endpoint. Falls back to bare IDs if
 * the server is OpenAI-compat-only.
 *
 * @param {string} apiUrl
 * @returns {Promise<ModelInfo[]>}
 */
export async function listModelsDetailed(apiUrl) {
  return await getInvoke()("list_models_detailed", { apiUrl });
}
