// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — main.js
//
// ============================================================
// v0.1 non-goals (Req 17.1-17.7) — verified absent from code:
//   - Single window, single Buffer, no tabs (Req 17.1):
//       index.html ships exactly one `<textarea id="buffer">`,
//       no tab strip, no split views, no second editor pane.
//   - No syntax styling (Req 17.2):
//       styles.css applies one uniform monospace rule to the
//       buffer with no token classes, no per-language CSS, and
//       no syntax-highlighter library imports anywhere.
//   - No theme/font/color controls (Req 17.3):
//       no theme/dark-mode/font/color UI in index.html, menu.js,
//       or settings_modal.js. Settings_Modal exposes only the six
//       Req 10.2 modal fields (api_url, model, tab_spaces). Inference
//       params (temperature, max_tokens, system prompt, etc.) live in
//       the inference panel.
//   - No plugin loader (Req 17.4):
//       no dynamic `import()` of user-supplied modules, no
//       plugin manifest, no extension registry.
//   - No autosave / focus-change writer (Req 17.5):
//       no `setInterval` / `setTimeout` writes, no `blur`,
//       `focusout`, or `beforeunload` listeners that touch the
//       file_service. Save runs only on explicit user action
//       (Req 5, Req 6, Req 7).
//   - No Markdown/HTML preview (Req 17.6):
//       no markdown/HTML rendering library, no `<iframe>`, and
//       no `innerHTML` write of buffer contents anywhere in the
//       frontend. The buffer is rendered exclusively by the
//       browser's native `<textarea>`.
//   - No preview-mode toggle (Req 17.7):
//       no `previewMode` state, no preview/edit switch UI, and
//       no menu item that swaps the buffer view.
//
// These invariants are build-time: any future change that adds
// one of the above must update both this comment and the
// matching Req 17 acceptance criterion.
// ============================================================
//
// Frontend bootstrap entry. Run on `DOMContentLoaded`:
//
//   1. `editor.initialize()` — bind the textarea so subsequent splice
//      pipelines have a live DOM handle (Req 1.2, Req 16.1).
//   2. Build the menu bar with the AI menu *disabled* so Req 1.3 / 2.6
//      hold for the entire window between window-open and the
//      `loadSettings()` resolution.
//   3. Render an initial Status_Bar reflecting the empty Untitled buffer
//      (Req 9.1, 9.2, 9.3, 9.4, 9.6, 9.7).
//   4. Attach the Status_Bar listener to the textarea so character
//      counts refresh on every input (Req 8.8).
//   5. Subscribe to the three Tauri events the backend emits:
//      `tauri://file-opened`, `tauri://llm-token`, `tauri://llm-complete`
//      (Req 16.2, Req 13.1, Req 13.5, Req 13.7, Req 14.6).
//   6. Subscribe to the `editor:status` `CustomEvent` so editor.js can
//      surface in-progress and error reasons in the Status_Bar without
//      a circular import on `status_bar.js`.
//   7. Call `api.loadSettings()`. While the promise is pending, the AI
//      menu stays disabled; when it resolves (success *or* fallback per
//      Req 1.6) we re-enable the AI menu and re-render the status bar
//      so the model name appears.
//
// Status_Bar state ownership. The canonical Status_Bar render arguments
// (path, model, dirty, error) live on the `statusState` module-private
// record below. Every code path that needs to refresh the bar
// (`tauri://file-opened`, `editor:status`, `loadSettings()` resolution)
// mutates `statusState` and re-runs `renderStatus()`. The textarea's
// `input` event recomputes `charCount` from the live buffer via the
// `attachToBuffer` helper from `status_bar.js` so the count stays in
// sync within the same tick (Req 8.8).
//
// References:
// - design.md: "Process lifecycle" → Bootstrap and Settings warm-up.
// - Requirements: 1.1, 1.2, 1.3, 1.6, 8.8, 9.1, 9.2, 9.4, 9.5, 12.6,
//                 12.7, 13.2, 13.3, 13.4, 13.5, 13.6, 14.6, 14.7,
//                 16.1, 16.2.

import * as api from "./api.js";
// editor / status_bar / settings_modal / menu are loaded via this single
// `import` chain so the index.html only needs the one
// `<script type="module" src="main.js">` tag. The execution order
// (api → editor → status_bar → settings_modal → menu → main) is
// preserved by the `import` graph: each module above is reached before
// `main.js` evaluates its body.
import * as editor from "./editor.js";
import { renderStatusBar, attachToBuffer } from "./status_bar.js";
import * as settingsModal from "./settings_modal.js";
import { buildMenuBar, setAiMenuEnabled } from "./menu.js";
import { attachEditorChrome } from "./editor_chrome.js";
import * as chat from "./chat.js";
import * as inferencePanel from "./inference_panel.js";
import { initToolEditor, getToolFileStatus } from "./tool_editor.js";
import { initToolConsole, setToolConsoleRuntime } from "./tool_console.js";
import { initPanelResize } from "./panel_resize.js";

// Re-export `settingsModal` so future code paths (and any debugging hook
// dropped into the WebView console) can reach it without a separate
// import. `void` discards the binding warning for tools that flag
// unused imports.
void settingsModal;

/**
 * Canonical Status_Bar state. The textarea `input` event re-derives
 * `charCount` from the live buffer; `path` and `dirty` are sourced
 * from the editor module directly (`editor.currentFilePath()`,
 * `editor.isDirty()`). Only `model` and `error` are owned here.
 *
 * @type {{
 *   model: string,
 *   error: string | null,
 * }}
 */
const statusState = {
  model: "",
  error: null,
  line: 1,
  column: 1,
};

/* ------------------------------------------------------------------ */
/* Status_Bar error contract (Req 14.6).                              */
/*                                                                     */
/* The Status_Bar is the SOLE error surface for backend command       */
/* failures and `tauri://llm-complete` error payloads. There are no   */
/* toast notifications, no modal popups for errors, and no inline    */
/* banners outside the Status_Bar — the dirty-buffer Save/Discard/   */
/* Cancel prompt is informational (Req 4.3, Req 7) and the           */
/* Settings_Modal's per-field validation lives inside the modal     */
/* during the validation flow (Req 11.4-11.7), not as an app-wide    */
/* error surface.                                                     */
/*                                                                     */
/* The two functions below are the explicit `setError(reason)` and    */
/* `clearError()` API: every call site in the codebase routes        */
/* through the `editor:status` `CustomEvent` channel, which the      */
/* listener registered by `registerEditorStatusListener()` mutates    */
/* into `statusState.error` and re-renders. The next successful      */
/* action (a successful Save, a clean stream completion, a fresh     */
/* Open) emits an empty-string `editor:status` payload which clears   */
/* the error slot — that is the "clear on the next successful         */
/* action" half of Req 14.6.                                          */
/* ------------------------------------------------------------------ */

/**
 * Set the Status_Bar error reason. The reason is rendered verbatim
 * in the bar's error slot (Req 14.6). Empty / null / undefined
 * values clear the slot via `clearError()` semantics.
 *
 * Internally this dispatches the same `editor:status` `CustomEvent`
 * channel used by editor.js, so a single listener in `main.js` is
 * the only consumer of error reasons regardless of origin (backend
 * command failure, `tauri://llm-complete` error payload, or a
 * direct `setError` call from the bootstrap path).
 *
 * @param {string | null | undefined} reason
 * @returns {void}
 */
export function setError(reason) {
  const message =
    typeof reason === "string" && reason.length > 0 ? reason : "";
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    // Direct fallback when CustomEvent is unavailable (e.g. minimal
    // test environments). Mutate state and render directly so the
    // contract still holds.
    statusState.error = message.length > 0 ? message : null;
    renderStatus();
    return;
  }
  try {
    document.dispatchEvent(
      new CustomEvent("editor:status", { detail: { message } })
    );
  } catch {
    statusState.error = message.length > 0 ? message : null;
    renderStatus();
  }
}

/**
 * Clear the Status_Bar error slot. Equivalent to `setError("")`;
 * provided as a named entry point so call sites that semantically
 * mean "the next successful action happened, drop any prior error"
 * read clearly.
 *
 * @returns {void}
 */
export function clearError() {
  setError("");
}

/**
 * Update the window title to reflect the current file.
 * Shows "LLIMEdit - Untitled" when no file is open, or
 * "LLIMEdit - filename.ext" when a file is associated with the buffer.
 *
 * @returns {void}
 */
function updateWindowTitle() {
  const filePath = editor.currentFilePath();
  const fileName =
    typeof filePath === "string" && filePath.length > 0
      ? filePath.split(/[/\\]/).pop() || "Untitled"
      : "Untitled";
  const title = `LLIMEdit - ${fileName}`;

  // Update the HTML document title (visible in browser tab / task bar).
  if (typeof document !== "undefined") {
    document.title = title;
  }

  // Update the native Tauri window title when running inside the shell.
  const tauri = globalThis.__TAURI__;
  if (tauri) {
    const w =
      (tauri.webviewWindow &&
        typeof tauri.webviewWindow.getCurrentWebviewWindow === "function" &&
        tauri.webviewWindow.getCurrentWebviewWindow()) ||
      (tauri.window &&
        typeof tauri.window.getCurrentWindow === "function" &&
        tauri.window.getCurrentWindow()) ||
      null;
    if (w && typeof w.setTitle === "function") {
      w.setTitle(title).catch(() => {
        /* best-effort; ignore failures */
      });
    }
  }
}

/**
 * Render the Status_Bar from `statusState` plus the live textarea
 * char-count. `attachToBuffer` runs the same render on every `input`
 * event; this function is the explicit re-render path for state
 * transitions outside an `input` event (e.g. settings warm-up,
 * editor:status, file-opened).
 *
 * @returns {void}
 */
function renderStatus() {
  const buffer =
    typeof document !== "undefined"
      ? document.getElementById("buffer")
      : null;
  const value = buffer && typeof buffer.value === "string" ? buffer.value : "";
  const toolStatus = getToolFileStatus();
  let path = editor.currentFilePath();
  if (toolStatus.path) {
    const toolLabel = toolStatus.path + (toolStatus.dirty ? " *" : "");
    const toolCount =
      toolStatus.toolCount > 0 ? ` · ${toolStatus.toolCount} tool${toolStatus.toolCount !== 1 ? "s" : ""}` : "";
    path = path && path.length > 0 ? `${path}  ·  ${toolLabel}${toolCount}` : `${toolLabel}${toolCount}`;
  }
  renderStatusBar({
    path,
    charCount: codePointLength(value),
    model: statusState.model,
    dirty: editor.isDirty(),
    error: statusState.error,
    line: statusState.line,
    column: statusState.column,
  });
  updateWindowTitle();
}

/**
 * Code-point length (Req 9.3 unit). Mirrors the helper inside
 * `status_bar.js` — kept local so this module can call it without
 * reaching into another module's private surface.
 *
 * @param {string} s
 * @returns {number}
 */
function codePointLength(s) {
  if (typeof s !== "string" || s.length === 0) return 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      let count = 0;
      // eslint-disable-next-line no-unused-vars
      for (const _ of s) count += 1;
      return count;
    }
  }
  return s.length;
}

/**
 * Subscribe `handler` to `event` on the Tauri event bus.
 *
 * Reaches into `window.__TAURI__.event.listen` directly so this module
 * does not have to depend on `api.js` for events (api.js is the
 * `invoke` shim). When `__TAURI__` is absent — Vitest+jsdom, for
 * example — the call is a silent no-op so unit tests of the bootstrap
 * do not need to mock the entire event API.
 *
 * @param {string} event
 * @param {(payload: unknown) => void} handler
 * @returns {Promise<undefined | (() => void)>}
 */
async function listen(event, handler) {
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.event || typeof tauri.event.listen !== "function") {
    return undefined;
  }
  return await tauri.event.listen(event, (payload) => handler(payload));
}

/**
 * Wire the three event subscriptions used by the editor and stream
 * pipelines. The handlers route every event through the editor module
 * so all Buffer mutations live in one place.
 *
 * Each handler is wrapped in a try/catch so a thrown error in one
 * handler does not tear down the others.
 */
async function registerTauriEventListeners() {
  // tauri://file-opened — emitted by the Rust setup helper after a
  // successful `open_file`; payload is the freshly decoded file
  // contents (Req 16.2). The event payload does not carry the path
  // (the frontend already has it from the matching `api.openFile`
  // resolution), so we pass `null` for the path here. The buffer
  // replacement clears both undo/redo stacks per Req 18.16.
  await listen("tauri://file-opened", (event) => {
    try {
      const payload = _extractEventPayload(event);
      const contents = typeof payload === "string" ? payload : "";
      editor._replaceBufferOnOpen(contents, null);
      // Status_Bar refresh per Req 16.2: the path is unknown from this
      // event alone (the path-aware path is `editor.openFile(path)`
      // → `_replaceBufferOnOpen(contents, path)`), so we leave the
      // current path at whatever the most recent `openFile(path)`
      // call already set. The dirty flag is re-derived from
      // `editor.isDirty()` on each render and is naturally false
      // because the buffer just matched its loaded snapshot.
      statusState.error = null;
      renderStatus();
    } catch (e) {
      console.error("file-opened handler failed:", e);
    }
  });

  // tauri://llm-token — emitted per non-empty assistant fragment during
  // a stream (Req 13.1). Forward the fragment through the editor's
  // `_handleStreamToken` helper which routes it to
  // `applyLLMResponse(streamAnchor.mode, fragment)` (Req 13.2-13.4)
  // and accumulates the change into the in-progress stream
  // `Edit_Group` (Req 13.9).
  await listen("tauri://llm-token", (event) => {
    try {
      const fragment = _extractEventPayload(event);
      if (typeof fragment === "string" && fragment.length > 0) {
        editor._handleStreamToken(fragment);
      }
    } catch (e) {
      console.error("llm-token handler failed:", e);
    }
  });

  await listen("tauri://llm-reasoning-token", (event) => {
    try {
      const fragment = _extractEventPayload(event);
      if (typeof fragment !== "string" || fragment.length === 0) return;
      if (typeof document === "undefined" || typeof CustomEvent !== "function") {
        return;
      }
      document.dispatchEvent(
        new CustomEvent("editor:reasoning-stream-token", {
          detail: { fragment },
        })
      );
    } catch (e) {
      console.error("llm-reasoning-token handler failed:", e);
    }
  });

  // tauri://llm-complete — emitted on stream end, cancellation, or any
  // Req 14 error reason (Req 13.5, 13.7, 14.6). The editor commits the
  // stream group onto undoStack (or skips on n=0 per Req 18.10),
  // re-enables the textarea (Req 13.6, 14.6), and dispatches an
  // `editor:status` event with the error reason verbatim when one is
  // present (Req 14.6, 14.7). Our subscriber on `editor:status` then
  // surfaces it in the Status_Bar.
  await listen("tauri://llm-complete", (event) => {
    try {
      const payload = _extractEventPayload(event);
      editor._handleStreamComplete(payload);
    } catch (e) {
      console.error("llm-complete handler failed:", e);
    }
  });
}

/**
 * Tauri's `listen` callback shape is `{ event, payload, ... }`. Tests
 * sometimes invoke handlers directly with the raw payload (no envelope),
 * so we accept either: when the value looks like a Tauri envelope
 * (`{ payload: ... }`), unwrap it; otherwise return as-is.
 *
 * @param {unknown} event
 * @returns {unknown}
 */
function _extractEventPayload(event) {
  if (event && typeof event === "object" && "payload" in event) {
    return event.payload;
  }
  return event;
}

/**
 * Subscribe to `editor:status` CustomEvents. editor.js dispatches these
 * for every Status_Bar message that originates inside the editor
 * module (Req 12.3 "Nothing to send", Req 12.6 in-progress indicator,
 * Req 12.7 already-in-progress, Req 14.6 error reason from
 * `tauri://llm-complete`, plus the undo/redo desync recovery message
 * from Task 21). The handler updates `statusState.error` so the
 * message renders in the bar's error slot, then triggers a re-render.
 *
 * Empty `message` strings clear the bar's error slot — they are used
 * by the clean stream-completion path to remove the in-progress
 * indicator.
 *
 * @returns {void}
 */
function registerEditorStatusListener() {
  if (typeof document === "undefined") return;
  document.addEventListener("editor:status", (event) => {
    try {
      const detail =
        event && typeof event === "object" && "detail" in event
          ? event.detail
          : null;
      const message =
        detail && typeof detail === "object" && typeof detail.message === "string"
          ? detail.message
          : "";
      statusState.error = message.length > 0 ? message : null;
      renderStatus();
    } catch (e) {
      console.error("editor:status handler failed:", e);
    }
  });
}

/**
 * Subscribe to `settings:model-changed` CustomEvents dispatched by
 * settings_modal.js after a successful save. Updates `statusState.model`
 * and re-renders the status bar so the model name stays in sync.
 *
 * @returns {void}
 */
function registerModelChangedListener() {
  if (typeof document === "undefined") return;
  document.addEventListener("settings:model-changed", (event) => {
    try {
      const detail =
        event && typeof event === "object" && "detail" in event
          ? event.detail
          : null;
      const model =
        detail && typeof detail === "object" && typeof detail.model === "string"
          ? detail.model
          : "";
      statusState.model = model;
      renderStatus();
    } catch (e) {
      console.error("settings:model-changed handler failed:", e);
    }
  });
}

/**
 * Wire the `tauri://close-requested` listener so the host window's
 * Quit / Cmd+Q / red-traffic-light close path runs the unsaved-changes
 * prompt before the WebView terminates (Req 7.1, 7.2).
 *
 * Tauri 2 emits `tauri://close-requested` on the window when something
 * outside the WebView (the OS, the dock menu, the user clicking the
 * window-close button) tries to close the window. The default
 * behavior is to close immediately. To intercept, the listener must
 * be registered with `closeRequested = true` on the capability — the
 * window stays open until we explicitly call `destroy()` (or the user
 * cancels and we leave it open).
 *
 * The handler:
 *   1. Reads `editor.isDirty()`. If false, calls `destroy()` so the
 *      window proceeds to close (Req 7.3).
 *   2. If dirty, runs `editor._promptDirtyBuffer()` for Save/Discard/
 *      Cancel (Req 7.1, 7.2). Save invokes `editor.saveFile()`; on
 *      success destroy the window (Req 7.5); on failure leave the
 *      window open and surface the error (Req 7.6). Discard destroys
 *      the window without writing (Req 7.7). Cancel leaves the
 *      window open (Req 7.8).
 *
 * In Vitest+jsdom there is no `__TAURI__` global, so this is a
 * silent no-op (matching the rest of the bootstrap).
 *
 * @returns {Promise<void>}
 */
async function registerCloseRequestedListener() {
  const tauri = globalThis.__TAURI__;
  if (!tauri) return;
  // Resolve the close-requested listener. Tauri 2 exposes window
  // helpers under `window.__TAURI__.window` (the legacy v1 module
  // path) and `window.__TAURI__.webviewWindow` (Tauri 2 explicit).
  // We try both so the bootstrap works against either shape.
  const w =
    (tauri.webviewWindow &&
      typeof tauri.webviewWindow.getCurrentWebviewWindow === "function" &&
      tauri.webviewWindow.getCurrentWebviewWindow()) ||
    (tauri.window &&
      typeof tauri.window.getCurrentWindow === "function" &&
      tauri.window.getCurrentWindow()) ||
    null;
  if (!w || typeof w.listen !== "function" || typeof w.destroy !== "function") {
    return;
  }
  await w.listen("tauri://close-requested", async () => {
    try {
      if (!editor.isDirty()) {
        // Req 7.3: not dirty → exit immediately.
        await w.destroy();
        return;
      }
      const choice = await editor._promptDirtyBuffer();
      if (choice === "cancel") {
        // Req 7.8: cancel aborts; leave the window open.
        return;
      }
      if (choice === "discard") {
        // Req 7.7: discard proceeds without writing.
        await w.destroy();
        return;
      }
      // Req 7.4 / 7.5 / 7.6: Save then proceed iff success.
      const saved = await editor.saveFile();
      if (saved === false) {
        // Req 7.6: save failed (or user cancelled the Save As
        // dialog it triggered) → abort the close. The error reason
        // has already been dispatched on `editor:status` by
        // `saveFile()` itself.
        return;
      }
      await w.destroy();
    } catch (err) {
      console.error("close-requested handler failed:", err);
    }
  });
}

/**
 * Bootstrap entry point. Idempotent enough for tests: every step looks
 * up its target DOM nodes by id, so re-running it inside a fresh jsdom
 * document does not crash.
 *
 * @returns {Promise<void>}
 */
export async function bootstrap() {
  // 1. Bind the buffer textarea.
  editor.initialize();

  // 2. Render the menu bar with the AI items disabled. Order matters:
  // build first, then disable, so the markup is in place before any
  // styling rule depending on `data-disabled` runs.
  buildMenuBar();
  setAiMenuEnabled(false);

  chat.initializeChat();
  await inferencePanel.initializeInferencePanel();
  initToolEditor();
  setToolConsoleRuntime({
    getContext: () => editor.getToolConsoleContext(),
    applyResult: (name, result) => editor.applyToolConsoleResult(name, result),
  });
  initToolConsole();
  if (!document.getElementById("tool-console-input")) {
    console.error(
      "[LLIMEdit] #tool-console is missing from the loaded page. " +
        "You are likely running a stale build — use `npm run dev` (not an old .app) " +
        "and confirm index.html contains llimedit-shell-rev: tool-console-1."
    );
  }
  initPanelResize();
  document.addEventListener("tool-file-changed", () => {
    renderStatus();
  });

  // 3. Initial Status_Bar: Untitled, 0 chars, model fallback per
  // Req 9.4 ("(no model)"). The model name is replaced after settings
  // resolve.
  renderStatus();

  // 4. Attach the live char-count listener to the textarea so every
  // input event refreshes the bar before the next user-input event
  // (Req 8.8). The accessor returns a snapshot of `statusState` so
  // path/dirty/model/error stay aligned with the rest of the app.
  const buffer =
    typeof document !== "undefined"
      ? document.getElementById("buffer")
      : null;
  if (buffer) {
    attachToBuffer(buffer, () => ({
      path: editor.currentFilePath(),
      model: statusState.model,
      dirty: editor.isDirty(),
      error: statusState.error,
      line: statusState.line,
      column: statusState.column,
    }));

    attachEditorChrome(buffer, {
      onCursorChange: (pos) => {
        statusState.line = pos.line;
        statusState.column = pos.column;
        renderStatus();
      },
    });
  }

  // 5. Subscribe to backend events before kicking off the warm-up so
  // any emit that races the warm-up still hits a listener.
  await registerTauriEventListeners();

  // 6. Subscribe to editor:status CustomEvents so editor-originated
  // Status_Bar messages (Req 12.3, 12.6, 12.7, 14.6, undo desync)
  // render in the bar without us reaching into editor.js internals.
  registerEditorStatusListener();

  // 6b. Subscribe to settings:model-changed so the status bar updates
  // when the user saves new settings from the modal.
  registerModelChangedListener();

  // 6a. Wire the close-requested guard so the Quit/window-close path
  // surfaces the unsaved-changes prompt before the window terminates
  // (Req 7).
  await registerCloseRequestedListener();

  // 7. Settings warm-up. The AI menu stays disabled until this resolves
  // (Req 1.3, Req 2.6); the resolution path enables it per Req 1.6
  // *whether the load succeeded or fell back to defaults*. Errors are
  // surfaced in the Status_Bar without blocking the menu enable, so the
  // user can immediately open the Settings_Modal to fix the on-disk
  // file (Req 10.5, 10.7).
  let settings;
  let settingsError = null;
  try {
    settings = await api.loadSettings();
  } catch (err) {
    settings = null;
    settingsError =
      err && typeof err === "object" && "message" in err
        ? String(err.message)
        : String(err);
  }

  setAiMenuEnabled(true);

  if (settings) {
    editor.applyEditorSettings(settings);
  }

  statusState.model =
    settings && typeof settings.model === "string" ? settings.model : "";
  statusState.error = settingsError;
  chat.setModelName(statusState.model);
  renderStatus();
}

// Wire the entry point. `DOMContentLoaded` fires once per document; if
// the script lands after the DOM has already parsed (`readyState` past
// `loading`) we kick off bootstrap immediately so we still hit the
// post-launch budget on Req 1.1.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bootstrap().catch((e) => console.error("bootstrap failed:", e));
    });
  } else {
    bootstrap().catch((e) => console.error("bootstrap failed:", e));
  }
}
