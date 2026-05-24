// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — editor.js
//
// Owns the single Buffer, dirty-flag, three insertion-mode appliers, the
// stream-anchor that turns a sequence of `tauri://llm-token` events into
// per-`replace_mode` Buffer mutations, and the public surface listed in
// Req 16.1. This file is the Task 18 fill-in for the skeleton stub:
// state, dirty-flag, and `applyLLMResponse(mode, fragment)` are real;
// `openFile` / `saveFile` / `saveFileAs` / `sendToLLM` /
// `loadSettings` / `saveSettings` / `undo` / `redo` are still no-op
// shells reserved for tasks 20, 21, and 23 to fill in.
//
// State (single-Buffer constraint, Req 17.1):
//   - `bufferEl`         the bound `<textarea id="buffer">` DOM node.
//   - `currentPath`      absolute file path of the bound buffer, or null
//                        for an Untitled buffer.
//   - `savedSnapshot`    the last-loaded-or-saved contents; `isDirty()`
//                        compares `bufferEl.value` against this string
//                        (Req 8.6, 8.7).
//   - `hadBom`           mirrors the backend `BufferMeta.had_bom` so a
//                        Save round-trips the BOM byte-for-byte.
//   - `lineEnding`       mirrors the backend `BufferMeta.line_ending`.
//   - `streamActive`     true while a `tauri://llm-token` series is
//                        being applied.
//   - `streamAnchor`     `{ mode, startCursor, startSelection,
//                        insertedLength, group }` allocated by
//                        `_beginStream(mode)` and discarded by
//                        `_endStream()`. The three insertion-mode
//                        appliers mutate `bufferEl.value` via this
//                        anchor (Req 13.2-13.4) and append per-token
//                        change records to `streamAnchor.group.changes`
//                        for the eventual single-Undo commit (Req 13.9,
//                        18.7-18.10).
//
// Code-point indexing. `streamAnchor.startCursor`,
// `startSelection.{start,end}`, and `insertedLength` are all expressed
// in Unicode code points, not UTF-16 code units. The splice helpers
// convert `bufferEl.value` to and from a code-point array so the
// arithmetic stays consistent with `[...fragment].length` per Req 13.2.
// `bufferEl.selectionStart` / `bufferEl.selectionEnd` are UTF-16
// indices reported by the DOM; `_beginStream` translates them via
// `utf16ToCodepoint` before recording them on the anchor.
//
// Task 20 fills in the typed-input grouping pipeline, the paste/cut
// handlers, the textarea event wiring that drives the `cursorJumped`
// flag, the FIFO-bounded `undoStack` / `redoStack` arrays, and the Open
// File stack-clearing path. `undo()` / `redo()` themselves remain stubs
// — Task 21 owns the consumer side.
//
// References:
//   design.md → "editor.js — Editor module"
//   design.md → "editor.js — UndoRedoStack submodule"
//   Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 13.2, 13.3,
//                 13.4, 16.1, 16.3, 18.1, 18.2, 18.3, 18.4, 18.5,
//                 18.6, 18.15, 18.16, 18.17, 18.18, 18.19, 18.20.

import * as api from "./api.js";
import { runAgent } from "./agent.js";
import { buildContextWindow } from "./context_window.js";

let bufferEl = null;
let currentPath = null;
let savedSnapshot = "";
let hadBom = false;
let lineEnding = "none";
let streamActive = false;
let agentActive = false;
/** @type {null | {
 *   mode: "insert_at_cursor" | "replace_selection" | "replace_document",
 *   startCursor: number,
 *   startSelection: { start: number, end: number },
 *   insertedLength: number,
 *   group: {
 *     source: "stream",
 *     beforeSelection: { start: number, end: number },
 *     afterSelection: { start: number, end: number },
 *     changes: Array<{ at: number, deleted: string, inserted: string }>,
 *     lastAppendedAt: number,
 *   },
 * }} */
let streamAnchor = null;

/* ------------------------------------------------------------------ */
/* Undo / Redo stack state (Req 18.1, 18.18-18.20).                    */
/*                                                                     */
/* Two module-private arrays of `EditGroup` records, both bounded to   */
/* exactly `UNDO_REDO_CAPACITY` entries with FIFO eviction on overflow */
/* (Req 18.18-18.20). Initialized to empty at module load (Req 18.1)   */
/* and reset to empty on a successful Open File (Req 18.16).           */
/* ------------------------------------------------------------------ */

const UNDO_REDO_CAPACITY = 200;
const undoStack = [];
const redoStack = [];

/* ------------------------------------------------------------------ */
/* Typed-input grouping signals (Req 18.2-18.4).                       */
/*                                                                     */
/* `cursorJumped` is the single boolean that breaks the typed-input    */
/* coalescing window. Any of the documented signals (arrow keys,       */
/* Home, End, PageUp, PageDown, mouse press / click on the textarea,  */
/* programmatic selection write, or a `select` event reflecting a     */
/* different selection from the previously recorded one) sets it to   */
/* `true`. The flag is consumed - and reset - by the next typed       */
/* keystroke evaluation, after which a fresh window starts against    */
/* whatever Edit_Group is now on top of the stack.                    */
/*                                                                     */
/* `lastRecordedSelection` is the snapshot of the textarea selection   */
/* at the moment of the previous keystroke append; comparing it       */
/* against the live selection is what makes a "different selection    */
/* from the previously recorded one" detectable on a `select` event   */
/* without false positives from the same-selection echo a typed       */
/* keystroke produces.                                                */
/* ------------------------------------------------------------------ */

let cursorJumped = false;
let lastRecordedSelection = { start: 0, end: 0 };

/**
 * Listener teardown handles installed by `_attachEventListeners`. We
 * keep them on a module-private list so `initialize()` can detach the
 * previous bindings before re-attaching, which keeps tests that
 * `initialize()` repeatedly inside a single jsdom document from
 * accumulating duplicate listeners on the same textarea.
 *
 * @type {Array<() => void>}
 */
let listenerTeardowns = [];

/* ------------------------------------------------------------------ */
/* Code-point indexing helpers.                                        */
/*                                                                     */
/* Spread-into-array (`[...str]`) iterates code points and gives the   */
/* code-point count via `.length`. We work in code-point space for     */
/* every splice so a fragment containing supplementary-plane chars     */
/* (emoji, etc.) advances the anchor by code-point count, not by       */
/* UTF-16 code-unit count.                                             */
/* ------------------------------------------------------------------ */

/**
 * Code-point length of `s`. `[...s].length` iterates the string by
 * code points (the iterator yields one entry per code point), so this
 * is the value Req 13.2 calls "the number of Unicode code points".
 *
 * @param {string} s
 * @returns {number}
 */
function codepointLength(s) {
  return [...s].length;
}

/**
 * Translate a UTF-16 index into the corresponding code-point index in
 * the same string. Walks the string with `codePointAt`, advancing by 2
 * UTF-16 units per supplementary-plane code point. The DOM reports
 * `selectionStart` / `selectionEnd` in UTF-16 units; the anchor stores
 * them in code-point units (per design.md, line 605). Indices that
 * land in the middle of a surrogate pair round down to the start of
 * that pair (`utf16Index` is treated as a closed upper bound).
 *
 * @param {string} s
 * @param {number} utf16Index
 * @returns {number}
 */
function utf16ToCodepoint(s, utf16Index) {
  let cp = 0;
  let i = 0;
  const limit = Math.min(utf16Index, s.length);
  while (i < limit) {
    const code = s.codePointAt(i);
    i += code !== undefined && code > 0xffff ? 2 : 1;
    cp += 1;
  }
  return cp;
}

/**
 * Splice in code-point space. Builds an array of code points from
 * `value`, removes `removeCount` of them starting at `at`, inserts the
 * code points of `insertion`, and joins back into a string. Returns
 * the new string and the literal text that was removed.
 *
 * @param {string} value
 * @param {number} at
 * @param {number} removeCount
 * @param {string} insertion
 * @returns {{ value: string, deleted: string }}
 */
function spliceCodepoints(value, at, removeCount, insertion) {
  const cp = [...value];
  const ins = [...insertion];
  const removed = cp.splice(at, removeCount, ...ins);
  return { value: cp.join(""), deleted: removed.join("") };
}

/* ------------------------------------------------------------------ */
/* Public surface (Req 16.1).                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the `<textarea id="buffer">` and stash it for later edit
 * pipeline work. Called by `main.js` on `DOMContentLoaded`.
 *
 * Idempotent: re-binding to the same element is a no-op so test setups
 * that re-run the bootstrap inside a fresh jsdom document do not
 * accumulate listeners or leak state. Resets `currentPath`,
 * `savedSnapshot`, the BOM/line-ending mirrors, and the stream anchor
 * so a fresh document starts clean.
 *
 * @returns {void}
 */
export function initialize() {
  // Detach any listeners installed against the previously-bound
  // buffer so a fresh `initialize()` inside the same document does
  // not leak handlers (and does not double-record keystrokes).
  for (const teardown of listenerTeardowns) {
    try {
      teardown();
    } catch {
      /* best-effort detach; nothing to do on failure */
    }
  }
  listenerTeardowns = [];

  bufferEl = document.getElementById("buffer");
  currentPath = null;
  savedSnapshot = bufferEl ? bufferEl.value : "";
  hadBom = false;
  lineEnding = "none";
  streamActive = false;
  streamAnchor = null;
  // Per Req 18.1, both stacks start empty at launch. `initialize` is
  // also called when the WebView reloads (e.g. devtools refresh), so
  // resetting the stacks here matches the user's mental model of "a
  // fresh window has nothing to undo".
  undoStack.length = 0;
  redoStack.length = 0;
  cursorJumped = false;
  lastRecordedSelection = _captureSelection();

  if (bufferEl) {
    _attachEventListeners(bufferEl);
  }
}

/**
 * Compute the dirty-flag (Req 8.6, 8.7). Returns `true` iff the live
 * buffer text differs from the last loaded/saved snapshot. Computed,
 * not flagged, so undo back to the saved state automatically clears
 * the asterisk in the Status_Bar.
 *
 * @returns {boolean}
 */
export function isDirty() {
  if (!bufferEl) return false;
  return bufferEl.value !== savedSnapshot;
}

/**
 * Whether a stream is currently in progress.
 *
 * Exposed so `menu.js` can implement the Req 3.7 / Req 12.6 / Req
 * 18.21 gating (document-modifying shortcuts and Edit-menu Undo/Redo
 * become no-ops while a stream is active) without reaching into the
 * private `streamActive` variable. Mirrors `_stateForTests().streamActive`
 * but is part of the supported in-app surface.
 *
 * @returns {boolean}
 */
export function isStreamActive() {
  return streamActive;
}

/**
 * Current file path associated with the Buffer, or `null` for an
 * Untitled buffer (Req 9.1, 9.2). Exposed so `main.js` and the
 * Status_Bar can render the path without reaching into the editor's
 * private state.
 *
 * @returns {string | null}
 */
export function currentFilePath() {
  return currentPath;
}

/**
 * Apply a single LLM token fragment to the Buffer using the
 * Insertion_Mode passed in (Req 13.2-13.4, Req 16.3).
 *
 * Mode validation runs first and synchronously throws on any value
 * outside the three allowed strings, before any mutation of the
 * buffer or stream anchor (Req 16.3). On a valid mode, dispatches to
 * one of the three private appliers, then dispatches a synthetic
 * `input` event so the Status_Bar character-count handler runs
 * (Req 8.8).
 *
 * If `streamAnchor` is null when this is called (the stream lifecycle
 * was not driven explicitly), it is implicitly initialized via
 * `_beginStream(mode)` against the current cursor/selection. Tasks 20
 * and 24 will drive the stream lifecycle from `sendToLLM` and the
 * `tauri://llm-complete` handler; this lazy init keeps unit tests of
 * the appliers concise.
 *
 * @param {"insert_at_cursor"|"replace_selection"|"replace_document"} mode
 * @param {string} fragment
 * @returns {void}
 */
export function applyLLMResponse(mode, fragment) {
  if (
    mode !== "insert_at_cursor" &&
    mode !== "replace_selection" &&
    mode !== "replace_document"
  ) {
    throw new Error(`invalid Insertion_Mode: ${mode}`);
  }
  if (!bufferEl) {
    throw new Error("editor not initialized");
  }
  if (streamAnchor === null) {
    _beginStream(mode);
  }
  if (mode === "insert_at_cursor") {
    applyInsertAtCursor(fragment);
  } else if (mode === "replace_selection") {
    applyReplaceSelection(fragment);
  } else {
    applyReplaceDocument(fragment);
  }
  bufferEl.dispatchEvent(new Event("input"));
}

/* ------------------------------------------------------------------ */
/* Public surface — file/LLM/settings/undo entry points.               */
/*                                                                     */
/* Tasks 20 / 21 / 23 fill these in. The signatures and exports are    */
/* fixed now so `menu.js` and `main.js` can wire the menu bar without  */
/* conditional imports.                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Public surface — file/LLM/settings/undo entry points.               */
/*                                                                     */
/* Task 23 fills in the remaining settings entry points. The           */
/* signatures and exports are fixed now so `menu.js` and `main.js`     */
/* can wire the menu bar without conditional imports.                  */
/* ------------------------------------------------------------------ */

/**
 * Open a file via the host platform's native picker (Req 4.1) and
 * load its contents into the Buffer.
 *
 * Flow:
 *   1. If the Buffer is dirty, prompt the user via
 *      `_promptDirtyBuffer()` for Save/Discard/Cancel (Req 4.3).
 *      - "save"     → invoke `saveFile()`. If save reports failure,
 *                     abort the open with no further state changes.
 *      - "discard"  → fall through to step 2 without writing.
 *      - "cancel"   → return immediately (Buffer/path/Status_Bar
 *                     untouched per Req 4.3 + Req 4.2).
 *   2. If `path` was supplied (used by the `tauri://file-opened`
 *      flow and unit tests), skip the dialog. Otherwise show the
 *      native open dialog with the documented extension filter
 *      `.txt`, `.md`, `.yaml`, `.yml`, `.pencil` plus an "All
 *      files" entry (Req 4.1). Cancel resolves to `null` and we
 *      return without changes (Req 4.2).
 *   3. Invoke `api.openFile(path)`. On success replace the buffer
 *      contents, refresh `savedSnapshot`, set `currentPath`, clear
 *      both undo/redo stacks (Req 18.16), and let `main.js` re-render
 *      the Status_Bar via the dispatched `input` + `editor:status`
 *      events (Req 4.4, 8.8). On failure surface the error verbatim
 *      via `editor:status` and leave the Buffer/path unchanged
 *      (Req 4.8, 4.9).
 *
 * @param {string} [path] Optional pre-resolved absolute path used by
 *   the `tauri://file-opened` flow and by tests. When omitted, the
 *   native picker is invoked.
 * @returns {Promise<void>}
 */
export async function openFile(path) {
  if (!bufferEl) return;

  // Dirty-buffer guard (Req 4.3). When the buffer is dirty we
  // surface the Save/Discard/Cancel prompt before any state change.
  if (isDirty()) {
    const choice = await _promptDirtyBuffer();
    if (choice === "cancel") return;
    if (choice === "save") {
      const saved = await saveFile();
      // saveFile() returns false when the user cancelled the
      // Save As dialog or the underlying write failed; in both
      // cases the original Open is aborted (Req 7.6 mirrors this
      // for Quit; the same rule applies on Open per Req 4.3 →
      // Req 7.3 chain).
      if (saved === false) return;
    }
    // "discard" falls through without writing.
  }

  // Resolve the target path. Tests and the `tauri://file-opened`
  // pathway pass a path explicitly; the menu/keyboard path resolves
  // it via the native dialog plugin.
  let target = path;
  if (typeof target !== "string" || target.length === 0) {
    let picked;
    try {
      picked = await _invokeOpenDialog();
    } catch (err) {
      _emitStatus(_errorMessage(err));
      return;
    }
    if (picked === null || picked === undefined) {
      // Req 4.2: cancel leaves state unchanged.
      return;
    }
    target = picked;
  }

  let contents;
  try {
    contents = await api.openFile(target);
  } catch (err) {
    // Req 4.8 / 4.9: leave Buffer / path / dirty unchanged and
    // render the failure reason in the Status_Bar.
    _emitStatus(_errorMessage(err));
    return;
  }
  _replaceBufferOnOpen(contents, target);
  // Clear any prior error from the Status_Bar on a successful load.
  _emitStatus("");
}

/**
 * Save the current Buffer to its associated path (Req 5).
 *
 * Per Req 18.17, every code path of `saveFile` MUST leave both undo
 * and redo stacks untouched, regardless of whether the underlying
 * `save_file` invoke succeeds or fails.
 *
 * Behavior:
 *   - When `currentPath` is null, delegate to `saveFileAs()`
 *     (Req 5.2) and return its boolean outcome.
 *   - Otherwise call `api.saveFile(currentPath, contents)`. On
 *     success, refresh `savedSnapshot`, dispatch an empty
 *     `editor:status` event so any prior error clears, and return
 *     `true`. On failure, dispatch the error reason verbatim and
 *     leave the Buffer dirty (Req 5.5); return `false`.
 *
 * The boolean return lets the Quit / Open dirty-prompt callers
 * decide whether to proceed (Req 7.5/7.6, Req 4.3 chain).
 *
 * @returns {Promise<boolean>} `true` on a successful save, `false` on
 *   failure or user cancellation of the Save As dialog.
 */
export async function saveFile() {
  if (!bufferEl) return false;
  if (currentPath === null) {
    // Req 5.2: no associated path → delegate to Save As.
    return await saveFileAs();
  }
  try {
    await api.saveFile(currentPath, bufferEl.value);
    savedSnapshot = bufferEl.value;
    // Successful save clears any prior error in the Status_Bar
    // (Req 5.4 status refresh + Req 14.6 inverse).
    _emitStatus("");
    return true;
  } catch (err) {
    // Req 5.5: render the failure reason verbatim and leave the
    // Buffer dirty. Per Req 18.17 we MUST NOT touch either stack.
    _emitStatus(_errorMessage(err));
    return false;
  }
}

/**
 * Save the current Buffer to a user-chosen path via the native save
 * dialog (Req 6).
 *
 * Flow:
 *   1. Resolve the suggested extension: the current file's extension
 *      when one is associated, otherwise `.txt` (Req 6.1).
 *   2. Open the native save dialog with the same extension filter
 *      list as Open (`.txt`, `.md`, `.yaml`, `.yml`, `.pencil` plus
 *      "All files"). Cancel returns `false` and leaves state
 *      unchanged (Req 6.2).
 *   3. Invoke `api.saveFile(newPath, contents)`. On success record
 *      the chosen absolute path as `currentPath`, refresh
 *      `savedSnapshot` (the BOM/line-ending preferences are cached
 *      in `BufferMeta` keyed by path on the backend, so a Save As
 *      to a previously-opened file retains them via Req 6.4), clear
 *      any prior error, and return `true`. On failure leave
 *      `currentPath` unchanged, dispatch the error reason verbatim,
 *      and return `false` (Req 6.6).
 *
 * Per Req 18.17 every code path leaves both undo/redo stacks
 * untouched.
 *
 * @returns {Promise<boolean>} `true` on a successful Save As, `false`
 *   when the user cancels or the write fails.
 */
export async function saveFileAs() {
  if (!bufferEl) return false;

  // Suggested extension per Req 6.1: pull the extension off the
  // current path when one exists, else `.txt`.
  const suggestedExt = _suggestedExtension(currentPath);

  let picked;
  try {
    picked = await _invokeSaveDialog(suggestedExt);
  } catch (err) {
    _emitStatus(_errorMessage(err));
    return false;
  }
  if (picked === null || picked === undefined) {
    // Req 6.2: cancel leaves state unchanged.
    return false;
  }

  try {
    await api.saveFile(picked, bufferEl.value);
  } catch (err) {
    // Req 6.6: currentPath stays put, Buffer remains dirty.
    _emitStatus(_errorMessage(err));
    return false;
  }
  currentPath = picked;
  savedSnapshot = bufferEl.value;
  _emitStatus("");
  return true;
}

/**
 * Compute the suggested-filename extension for the Save As dialog.
 * Returns the extension of `path` (including the leading dot) when
 * present, otherwise `".txt"` (Req 6.1).
 *
 * @param {string|null} path
 * @returns {string}
 */
function _suggestedExtension(path) {
  if (typeof path !== "string" || path.length === 0) return ".txt";
  // Use the filename portion only so a directory containing a dot
  // (e.g. `/some/v1.0/file`) does not collide with the extension
  // detection.
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return ".txt"; // no extension or hidden file
  return filename.slice(dot);
}

/**
 * Filter list shared by the Open and Save As dialogs (Req 4.1, 6.1).
 * The first entry is the "Text" group (the documented extension set);
 * the second is the "All files" wildcard.
 *
 * @returns {Array<{ name: string, extensions: string[] }>}
 */
function _dialogFilters() {
  return [
    { name: "JSON", extensions: ["json"] },
    { name: "Text", extensions: ["txt", "md", "yaml", "yml", "pencil"] },
    { name: "All files", extensions: ["*"] },
  ];
}

/**
 * Invoke the Tauri dialog plugin's `open` for a single-file pick.
 * Returns the selected path string, or `null` if the user cancelled.
 *
 * The Tauri 2 dialog plugin exposes `open({ multiple, filters })`
 * under `window.__TAURI__.dialog`. When the plugin is unavailable
 * (Vitest+jsdom, for example), we surface that as a status message
 * and resolve to `null` so callers treat it as a cancel.
 *
 * @returns {Promise<string|null>}
 */
async function _invokeOpenDialog() {
  if (typeof _openDialogOverride === "function") {
    return await _openDialogOverride();
  }
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.dialog || typeof tauri.dialog.open !== "function") {
    _emitStatus("file dialog unavailable");
    return null;
  }
  const result = await tauri.dialog.open({
    multiple: false,
    filters: _dialogFilters(),
  });
  // Tauri 2 returns a string for single-file picks, an array for
  // multi, or `null` on cancel. We only ever call `multiple: false`,
  // but handle the array form defensively in case a future plugin
  // version normalizes.
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return result.length > 0 ? result[0] : null;
  return typeof result === "string" ? result : null;
}

/**
 * Invoke the Tauri dialog plugin's `save` for a single-file save.
 * Returns the chosen path string, or `null` if the user cancelled.
 *
 * @param {string} suggestedExt Suggested extension (with leading dot)
 *   used to populate the dialog's default filter selection.
 * @returns {Promise<string|null>}
 */
async function _invokeSaveDialog(suggestedExt) {
  if (typeof _saveDialogOverride === "function") {
    return await _saveDialogOverride(suggestedExt);
  }
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.dialog || typeof tauri.dialog.save !== "function") {
    _emitStatus("file dialog unavailable");
    return null;
  }
  const ext = suggestedExt.startsWith(".") ? suggestedExt.slice(1) : suggestedExt;
  const filters = _dialogFilters();
  // Prefer the filter matching the suggested extension when present.
  const matchIdx = filters.findIndex(
    (f) => f.extensions.length === 1 && f.extensions[0] === ext
  );
  if (matchIdx > 0) {
    const preferred = filters[matchIdx];
    filters.splice(matchIdx, 1);
    filters.unshift(preferred);
  }
  const result = await tauri.dialog.save({
    filters,
    defaultPath: typeof currentPath === "string" ? currentPath : undefined,
  });
  if (result === null || result === undefined) return null;
  return typeof result === "string" ? result : null;
}

/**
 * Test/dependency-injection hook for the Open dialog. When set to a
 * function, `_invokeOpenDialog` will await it instead of reaching for
 * `__TAURI__.dialog.open`. Pass `null` to restore the default.
 *
 * @type {(() => Promise<string|null>) | null}
 */
let _openDialogOverride = null;

/**
 * Test/dependency-injection hook for the Save dialog. When set to a
 * function, `_invokeSaveDialog` will await it instead of reaching for
 * `__TAURI__.dialog.save`. The function receives the suggested
 * extension (with leading dot).
 *
 * @type {((ext: string) => Promise<string|null>) | null}
 */
let _saveDialogOverride = null;

/**
 * Test/dependency-injection hook for the dirty-buffer Save/Discard/
 * Cancel prompt. When set to a function, `_promptDirtyBuffer` will
 * await it instead of building a real DOM modal.
 *
 * @type {(() => Promise<"save"|"discard"|"cancel">) | null}
 */
let _dirtyBufferPromptOverride = null;

/**
 * Test hook: install/clear the dialog override functions used by
 * `_invokeOpenDialog`, `_invokeSaveDialog`, and `_promptDirtyBuffer`.
 *
 * @param {{
 *   open?: (() => Promise<string|null>) | null,
 *   save?: ((ext: string) => Promise<string|null>) | null,
 *   prompt?: (() => Promise<"save"|"discard"|"cancel">) | null,
 * }} overrides
 * @returns {void}
 */
export function _setFileDialogsForTests(overrides) {
  if (!overrides) {
    _openDialogOverride = null;
    _saveDialogOverride = null;
    _dirtyBufferPromptOverride = null;
    return;
  }
  if ("open" in overrides) _openDialogOverride = overrides.open || null;
  if ("save" in overrides) _saveDialogOverride = overrides.save || null;
  if ("prompt" in overrides) _dirtyBufferPromptOverride = overrides.prompt || null;
}

/**
 * Display a Save / Discard / Cancel modal asking the user how to
 * resolve a dirty buffer before an Open or Quit. Resolves to one of
 * the three button identifiers.
 *
 * Builds (or reuses) a tiny inline modal appended to `<body>`. The
 * modal participates in the same `.modal` styling rules used by the
 * Settings_Modal. Keyboard: Escape resolves with `"cancel"`. Clicks
 * outside the modal content resolve with `"cancel"` so the user
 * cannot dismiss without an explicit decision.
 *
 * @returns {Promise<"save"|"discard"|"cancel">}
 */
export async function _promptDirtyBuffer() {
  if (typeof _dirtyBufferPromptOverride === "function") {
    return await _dirtyBufferPromptOverride();
  }
  if (typeof document === "undefined") return "cancel";
  return await new Promise((resolve) => {
    let resolved = false;
    const finalize = (choice) => {
      if (resolved) return;
      resolved = true;
      modal.remove();
      document.removeEventListener("keydown", onKeydown, true);
      resolve(choice);
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        finalize("cancel");
      }
    };

    const modal = document.createElement("div");
    modal.className = "modal dirty-buffer-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Unsaved changes");

    const content = document.createElement("div");
    content.className = "modal-content";

    const heading = document.createElement("h2");
    heading.textContent = "Unsaved changes";
    content.appendChild(heading);

    const body = document.createElement("p");
    body.textContent =
      "You have unsaved changes. Save them, discard them, or cancel?";
    content.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const buttons = [
      { label: "Save", choice: "save" },
      { label: "Discard", choice: "discard" },
      { label: "Cancel", choice: "cancel" },
    ];
    for (const { label, choice } of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.dataset.choice = choice;
      btn.addEventListener("click", () => finalize(choice));
      footer.appendChild(btn);
    }
    content.appendChild(footer);
    modal.appendChild(content);

    // Click outside content -> cancel.
    modal.addEventListener("click", (e) => {
      if (e.target === modal) finalize("cancel");
    });

    document.body.appendChild(modal);
    document.addEventListener("keydown", onKeydown, true);
    // Focus the Save button by default so Enter activates the
    // primary action.
    const firstBtn = footer.querySelector("button");
    if (firstBtn && typeof firstBtn.focus === "function") firstBtn.focus();
  });
}

/**
 * Send the current selection (or the full Buffer when no selection
 * exists) to the LM Studio endpoint, stream the response back into the
 * Editor, and surface progress/errors via the Status_Bar (Req 12.1,
 * 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 13.2, 13.3, 13.4, 14.6, 14.7).
 *
 * Pre-conditions and short-circuits, in order:
 *   1. If a stream is already active, dispatch an `editor:status`
 *      event with the literal "A request is already in progress" and
 *      return without calling the backend (Req 12.7).
 *   2. Load the current settings via `api.loadSettings()`. The
 *      `replace_mode` field of the resolved settings becomes the
 *      Insertion_Mode for this stream (Req 13.2-13.4).
 *   3. Resolve the user-message content: when
 *      `selectionStart !== selectionEnd` use `bufferEl.value.slice(
 *      selectionStart, selectionEnd)` (Req 12.1); otherwise use the
 *      entire `bufferEl.value` (Req 12.2).
 *   4. If the resolved content is empty in Unicode code points,
 *      dispatch an `editor:status` event with the literal "Nothing
 *      to send" and return without opening a connection (Req 12.3).
 *
 * Stream lifecycle:
 *   - Allocate `streamAnchor` via `_beginStream(settings.replace_mode)`.
 *     `_beginStream` captures the cursor/selection at start and
 *     allocates the in-progress `Edit_Group` for the eventual
 *     single-Undo commit (Req 13.9, 18.7).
 *   - Set `bufferEl.disabled = true` so the textarea rejects every
 *     keyboard and paste input that would modify the Buffer
 *     (Req 12.6).
 *   - Dispatch an `editor:status` event with a visible in-progress
 *     indicator (Req 12.6); main.js renders this verbatim in the
 *     Status_Bar.
 *   - Invoke `api.streamLlm(text, settings)`. The backend returns
 *     within ~200ms after spawning its worker (Req 15.4); subsequent
 *     `tauri://llm-token` and `tauri://llm-complete` events drive the
 *     rest of the lifecycle through `_handleStreamToken` and
 *     `_handleStreamComplete`.
 *
 * If `api.streamLlm` rejects synchronously (e.g. the backend reports
 * `"a stream is already active"` because of a stale single-flight
 * slot), tear down the anchor via `_endStream()`, re-enable
 * `bufferEl`, and surface the rejection reason as an `editor:status`
 * event so the Status_Bar mirrors the failure (Req 14.6, 14.7).
 *
 * @returns {Promise<void>}
 */
export async function sendToLLM() {
  if (!bufferEl) return;

  const value = bufferEl.value;
  const selStart =
    typeof bufferEl.selectionStart === "number" ? bufferEl.selectionStart : 0;
  const selEnd =
    typeof bufferEl.selectionEnd === "number" ? bufferEl.selectionEnd : selStart;
  const text =
    selStart !== selEnd ? value.slice(selStart, selEnd) : value;

  await _sendPromptToLLM(text);
}

/**
 * Send a chat instruction to the model using the tool-use agent loop.
 * Document edits are applied via editor tools; assistant replies appear
 * in the chat panel only.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function sendChatMessage(text) {
  if (!bufferEl) return;
  const prompt = typeof text === "string" ? text.trim() : "";
  await _sendAgentPrompt(prompt);
}

/**
 * Run the tool-use agent loop for a chat instruction.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
async function _sendAgentPrompt(text) {
  if (agentActive || streamActive) {
    _emitStatus("A request is already in progress");
    return;
  }

  let settings;
  try {
    settings = await api.loadSettings();
  } catch (err) {
    _emitStatus(_errorMessage(err));
    return;
  }

  if (text.length === 0) {
    _emitStatus("Nothing to send");
    return;
  }

  agentActive = true;
  _emitChatStart(text);
  _emitStatus("Thinking…");

  const selStart =
    typeof bufferEl.selectionStart === "number" ? bufferEl.selectionStart : 0;
  const selEnd =
    typeof bufferEl.selectionEnd === "number" ? bufferEl.selectionEnd : selStart;
  const contextAnchor = buildContextWindow(bufferEl.value, selStart, selEnd);

  try {
    await runAgent({
      userMessage: text,
      settings,
      bufferEl,
      contextAnchor,
      documentPath: currentPath,
      callbacks: {
        getDocumentContext: () => ({
          text: bufferEl.value,
          path: currentPath,
          contextAnchor,
        }),
        onToolCall: (toolCall) => {
          _emitToolCall(toolCall);
        },
        onToolResult: (toolCall, result) => {
          _emitToolResult(toolCall, result);
        },
        onAssistantMessage: (message) => {
          _emitChatAssistant(message);
        },
      },
    });
    _emitStatus("");
  } catch (err) {
    _emitStatus(_errorMessage(err));
  } finally {
    agentActive = false;
    _emitChatComplete();
  }
}

/**
 * Shared LLM send path for menu/shortcut and chat panel invocations.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
async function _sendPromptToLLM(text) {

  // Req 12.7: a second invocation while a stream is active is
  // dropped with the documented status message.
  if (streamActive) {
    _emitStatus("A request is already in progress");
    return;
  }

  let settings;
  try {
    settings = await api.loadSettings();
  } catch (err) {
    _emitStatus(_errorMessage(err));
    return;
  }

  // Req 12.3: 0 code points -> "Nothing to send", no backend call.
  if (text.length === 0) {
    _emitStatus("Nothing to send");
    return;
  }

  // Allocate the stream anchor + Edit_Group at the captured
  // cursor/selection (Req 13.2-13.4, 13.9, 18.7) and flip
  // `streamActive` so the gating in undo/redo and recordTypedKeystroke
  // takes effect.
  const mode =
    settings && typeof settings.replace_mode === "string"
      ? settings.replace_mode
      : "replace_document";
  try {
    _beginStream(mode);
  } catch (err) {
    // An invalid `replace_mode` from settings (defensive only — the
    // backend validates this) would throw out of `_beginStream`. Surface
    // it via the same channel the rest of the failure paths use.
    _emitStatus(_errorMessage(err));
    return;
  }

  _emitChatStart(text);

  // Req 12.6: disable the textarea so keyboard and paste input cannot
  // modify the Buffer while the stream is in flight. The
  // `tauri://llm-complete` handler re-enables it.
  bufferEl.disabled = true;
  // Req 12.6 visible indicator: dispatch the "Streaming…" status so
  // main.js can render it in the Status_Bar.
  _emitStatus("Streaming…");

  try {
    await api.streamLlm(text, settings);
  } catch (err) {
    // Synchronous rejection (e.g. the backend's "a stream is already
    // active" single-flight error). Roll back the local state so the
    // editor is usable again and surface the reason in the
    // Status_Bar (Req 14.6, 14.7).
    _endStream();
    bufferEl.disabled = false;
    _emitStatus(_errorMessage(err));
    _emitChatComplete();
  }
}

export async function loadSettings() {}
export async function saveSettings() {}

/**
 * Apply a single streamed token fragment to the Buffer.
 *
 * Invoked by `main.js` from the `tauri://llm-token` listener. Routes
 * the fragment through `applyLLMResponse(streamAnchor.mode, fragment)`
 * so the active Insertion_Mode (recorded at stream start) drives the
 * splice (Req 13.2-13.4). Each applied fragment appends a
 * `{ at, deleted, inserted }` change record onto the in-progress
 * stream `Edit_Group` so the eventual commit on `tauri://llm-complete`
 * is a single Undo step (Req 13.9, 18.7).
 *
 * Defensive: if no stream is active or the anchor is missing
 * (a stray emit after a teardown), the call is a silent no-op.
 *
 * @param {string} fragment
 * @returns {void}
 */
export function _handleStreamToken(fragment) {
  if (!bufferEl || !streamActive || streamAnchor === null) return;
  if (typeof fragment !== "string" || fragment.length === 0) return;
  applyLLMResponse(streamAnchor.mode, fragment);
  _emitChatToken(fragment);
}

/**
 * Handle the terminal `tauri://llm-complete` event.
 *
 * Commits the in-progress stream `Edit_Group` onto `undoStack` if any
 * tokens were applied (Req 13.9, 18.8, 18.9, 18.10), tears down the
 * stream anchor, clears `streamActive`, and re-enables `bufferEl`
 * (Req 13.6, 14.6, 14.7). When `payload.error` is a non-empty string,
 * the error reason is surfaced verbatim via an `editor:status` event
 * so `main.js` renders it in the Status_Bar (Req 14.6).
 *
 * @param {{ error?: string | null } | null | undefined} payload
 * @returns {void}
 */
export function _handleStreamComplete(payload) {
  // Commit the stream group (or no-op if changes is empty per
  // Req 18.10) and clear stream state. `_completeStream` is
  // idempotent on a missing anchor.
  _completeStream();
  if (bufferEl) bufferEl.disabled = false;

  const error =
    payload && typeof payload === "object" && typeof payload.error === "string"
      ? payload.error
      : null;
  if (error && error.length > 0) {
    _emitStatus(error);
  } else {
    // Clean completion: clear any prior in-progress indicator from
    // the Status_Bar so the bar returns to its idle text.
    _emitStatus("");
  }
  _emitChatComplete();
}

/**
 * Dispatch a `CustomEvent("editor:status", { detail: { message } })`
 * on `document` so `main.js` can re-render the Status_Bar with the
 * message in its error slot. Wraps the dispatch in try/catch because
 * not every test environment supports `CustomEvent`.
 *
 * @param {string} message
 * @returns {void}
 */
function _emitStatus(message) {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    return;
  }
  try {
    document.dispatchEvent(
      new CustomEvent("editor:status", { detail: { message } })
    );
  } catch {
    /* ignore — status surfacing is best-effort */
  }
}

/**
 * @param {string} text
 * @returns {void}
 */
function _emitChatStart(text) {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    return;
  }
  try {
    document.dispatchEvent(
      new CustomEvent("editor:chat-start", { detail: { text } })
    );
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} fragment
 * @returns {void}
 */
function _emitChatToken(fragment) {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    return;
  }
  try {
    document.dispatchEvent(
      new CustomEvent("editor:chat-token", { detail: { fragment } })
    );
  } catch {
    /* ignore */
  }
}

/**
 * @returns {void}
 */
function _emitChatComplete() {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    return;
  }
  try {
    document.dispatchEvent(new CustomEvent("editor:chat-complete"));
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ name: string, arguments: string }} toolCall
 * @returns {void}
 */
function _emitToolCall(toolCall) {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    return;
  }
  try {
    document.dispatchEvent(
      new CustomEvent("editor:tool-call", { detail: { toolCall } })
    );
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ name: string, arguments: string }} toolCall
 * @param {Record<string, unknown>} result
 * @returns {void}
 */
function _emitToolResult(toolCall, result) {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    return;
  }
  try {
    document.dispatchEvent(
      new CustomEvent("editor:tool-result", { detail: { toolCall, result } })
    );
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} message
 * @returns {void}
 */
function _emitChatAssistant(message) {
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    return;
  }
  try {
    document.dispatchEvent(
      new CustomEvent("editor:chat-assistant", { detail: { message } })
    );
  } catch {
    /* ignore */
  }
}

/**
 * Coerce an arbitrary thrown/rejected value into a human-readable
 * message string. Tauri rejections come through as plain strings (the
 * catalog entries from `error.rs`), but `Error` instances and
 * arbitrary objects are also possible from the JS side; this helper
 * handles all three uniformly.
 *
 * @param {unknown} err
 * @returns {string}
 */
function _errorMessage(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object" && "message" in err) {
    return String(err.message);
  }
  return String(err);
}

/**
 * Revert the topmost `Edit_Group` on `undoStack` (Req 18.11).
 *
 * No-op while a stream is active (Req 18.21 + Req 12.6) so a stray
 * Cmd/Ctrl+Z arriving during streaming cannot drift the buffer from
 * the in-progress stream group. No-op when `undoStack` is empty
 * (Req 18.12) so the user gets the documented "do nothing" feedback
 * instead of an error.
 *
 * On a non-empty stack, applies every change in `group.changes` in
 * reverse order with the deleted/inserted strings swapped, restores
 * `group.beforeSelection`, pushes the group onto `redoStack`
 * (Req 18.11), and dispatches a synthetic `input` event so the
 * Status_Bar character count refreshes.
 *
 * The bounds-check fallback runs as a dry pass against a working
 * copy: every change must satisfy both the index-range constraint
 * (`at` in `[0, len]` and `at + codepointLen(inserted) <= len`) and
 * the content constraint (`slice(at, at + codepointLen(inserted)) ===
 * inserted`). On any mismatch, the group is re-pushed onto
 * `undoStack` so neither stack changes, an error is logged via
 * `console.error`, and the literal "undo/redo state desynchronized;
 * please retry" message is dispatched on `document` as an
 * `editor:status` `CustomEvent` so `main.js` can surface it in the
 * Status_Bar without us creating a circular import.
 *
 * @returns {void}
 */
export function undo() {
  if (streamActive) return; // Req 18.21
  if (!bufferEl) return;
  const group = undoStack.pop();
  if (group === undefined) return; // Req 18.12
  const next = _applyChangesReverse(bufferEl.value, group.changes);
  if (next === null) {
    // Bounds-check failure: leave both stacks unchanged.
    undoStack.push(group);
    _emitDesyncStatus("undo", group);
    return;
  }
  bufferEl.value = next;
  _restoreSelection(group, group.beforeSelection);
  pushOnto(redoStack, group);
  bufferEl.dispatchEvent(new Event("input"));
}

/**
 * Re-apply the topmost `Edit_Group` on `redoStack` (Req 18.13).
 *
 * No-op while a stream is active (Req 18.21) and when `redoStack` is
 * empty (Req 18.14). Otherwise applies every change in
 * `group.changes` in original order, restores `group.afterSelection`,
 * and pushes the group back onto `undoStack` via `pushUndo(group, {
 * fromRedo: true })` so the rest of the redo history is preserved
 * (Req 18.13: redo does NOT clear `redoStack`).
 *
 * Bounds-check fallback mirrors `undo()`: a dry pass validates each
 * change's index range and content (`slice(at, at + codepointLen(
 * deleted)) === deleted`); on mismatch the group is re-pushed onto
 * `redoStack`, `console.error` runs, and the desync status message
 * is dispatched.
 *
 * @returns {void}
 */
export function redo() {
  if (streamActive) return; // Req 18.21
  if (!bufferEl) return;
  const group = redoStack.pop();
  if (group === undefined) return; // Req 18.14
  const next = _applyChangesForward(bufferEl.value, group.changes);
  if (next === null) {
    redoStack.push(group);
    _emitDesyncStatus("redo", group);
    return;
  }
  bufferEl.value = next;
  _restoreSelection(group, group.afterSelection);
  // fromRedo: true preserves the rest of redoStack (Req 18.13).
  pushUndo(group, { fromRedo: true });
  bufferEl.dispatchEvent(new Event("input"));
}

/* ------------------------------------------------------------------ */
/* Private appliers (Req 13.2-13.4).                                   */
/*                                                                     */
/* All three operate on `bufferEl.value` directly, splice in           */
/* code-point space against the anchor recorded at stream start, and   */
/* append a `{ at, deleted, inserted }` change record to               */
/* `streamAnchor.group.changes` so that Task 21 can commit the entire  */
/* stream as a single Undo step (Req 13.9, 18.7).                      */
/* ------------------------------------------------------------------ */

/**
 * `insert_at_cursor` (Req 13.2): splice `fragment` in at
 * `streamAnchor.startCursor + streamAnchor.insertedLength`, then
 * advance `insertedLength` by the code-point count of `fragment`.
 *
 * @param {string} fragment
 * @returns {void}
 */
function applyInsertAtCursor(fragment) {
  const at = streamAnchor.startCursor + streamAnchor.insertedLength;
  const { value, deleted } = spliceCodepoints(bufferEl.value, at, 0, fragment);
  bufferEl.value = value;
  streamAnchor.insertedLength += codepointLength(fragment);
  streamAnchor.group.changes.push({ at, deleted, inserted: fragment });
}

/**
 * `replace_selection` (Req 13.3): on the first token, replace
 * `[startSelection.start, startSelection.end)` with `fragment`; on
 * subsequent tokens, splice at `startSelection.start + insertedLength`.
 * An empty captured selection collapses to the insert-at-cursor case
 * — Req 13.3 explicitly defers to the cursor-position branch when the
 * pre-stream selection had length zero.
 *
 * "First token" is detected by `insertedLength === 0`; the
 * `insertedLength` field counts code points emitted from this stream
 * so far, which is zero before the first applier call lands.
 *
 * @param {string} fragment
 * @returns {void}
 */
function applyReplaceSelection(fragment) {
  const { startSelection } = streamAnchor;
  const isFirstToken = streamAnchor.insertedLength === 0;
  let at;
  let removeCount;
  if (isFirstToken) {
    at = startSelection.start;
    removeCount = startSelection.end - startSelection.start;
  } else {
    at = startSelection.start + streamAnchor.insertedLength;
    removeCount = 0;
  }
  const { value, deleted } = spliceCodepoints(
    bufferEl.value,
    at,
    removeCount,
    fragment
  );
  bufferEl.value = value;
  streamAnchor.insertedLength += codepointLength(fragment);
  streamAnchor.group.changes.push({ at, deleted, inserted: fragment });
}

/**
 * `replace_document` (Req 13.4): on the first token, set the entire
 * buffer to `fragment` (recording the prior contents as `deleted` so
 * the change record can be undone losslessly). On subsequent tokens,
 * append `fragment` to the end of the buffer.
 *
 * The "first token" branch is detected by `insertedLength === 0`. The
 * append branch records `at` as the buffer's code-point length at the
 * moment of the splice.
 *
 * @param {string} fragment
 * @returns {void}
 */
function applyReplaceDocument(fragment) {
  if (streamAnchor.insertedLength === 0) {
    const previous = bufferEl.value;
    bufferEl.value = fragment;
    streamAnchor.insertedLength += codepointLength(fragment);
    streamAnchor.group.changes.push({
      at: 0,
      deleted: previous,
      inserted: fragment,
    });
    return;
  }
  const at = codepointLength(bufferEl.value);
  bufferEl.value = bufferEl.value + fragment;
  streamAnchor.insertedLength += codepointLength(fragment);
  streamAnchor.group.changes.push({ at, deleted: "", inserted: fragment });
}

/* ------------------------------------------------------------------ */
/* Stream-anchor lifecycle.                                            */
/*                                                                     */
/* Exposed as `_beginStream` / `_endStream` (underscore prefix marks   */
/* them as not part of the Req 16.1 surface). Task 24 wires            */
/* `_beginStream` to the `sendToLLM` resolution path and `_endStream`  */
/* to the `tauri://llm-complete` handler; for Task 18, `applyLLMResponse`*/
/* lazy-initialises the anchor when the host has not done so. Tests   */
/* drive these directly to set up scenarios.                           */
/* ------------------------------------------------------------------ */

/**
 * Allocate a fresh `streamAnchor` at the current cursor/selection and
 * mark the editor as having an active stream. Captures the cursor and
 * selection in *code-point* indices (the DOM reports them in UTF-16,
 * so they are translated via `utf16ToCodepoint`). Initialises the
 * in-progress `Edit_Group` (Req 13.9, 18.7) with `source: "stream"`,
 * `beforeSelection` set to the captured selection, and an empty
 * `changes` array.
 *
 * @param {"insert_at_cursor"|"replace_selection"|"replace_document"} mode
 * @returns {void}
 */
export function _beginStream(mode) {
  if (!bufferEl) {
    throw new Error("editor not initialized");
  }
  if (
    mode !== "insert_at_cursor" &&
    mode !== "replace_selection" &&
    mode !== "replace_document"
  ) {
    throw new Error(`invalid Insertion_Mode: ${mode}`);
  }
  const value = bufferEl.value;
  const rawStart =
    typeof bufferEl.selectionStart === "number" ? bufferEl.selectionStart : 0;
  const rawEnd =
    typeof bufferEl.selectionEnd === "number" ? bufferEl.selectionEnd : rawStart;
  const start = utf16ToCodepoint(value, rawStart);
  const end = utf16ToCodepoint(value, rawEnd);
  streamAnchor = {
    mode,
    startCursor: start,
    startSelection: { start, end },
    insertedLength: 0,
    group: {
      source: "stream",
      beforeSelection: { start, end },
      afterSelection: { start, end },
      changes: [],
      lastAppendedAt: Date.now(),
    },
  };
  streamActive = true;
}

/**
 * Discard the current `streamAnchor` and mark the editor as no longer
 * streaming. Task 21's `tauri://llm-complete` handler will call this
 * after committing the stream's `Edit_Group` to `undoStack`.
 *
 * @returns {void}
 */
export function _endStream() {
  streamAnchor = null;
  streamActive = false;
}

/**
 * Commit the in-progress stream `Edit_Group` to `undoStack` if the
 * stream produced at least one applied token (Req 18.8 end-of-stream,
 * Req 18.9 user cancellation, Req 18.10 Req 14 errors with `n >= 1`),
 * then discard the stream anchor and clear `streamActive`. When the
 * stream errored before any token arrived (`changes.length === 0`),
 * Req 18.10's "one or more `tauri://llm-token` events were received"
 * precondition is unmet, so nothing is pushed; we still tear down the
 * anchor so the editor returns to its non-streaming state.
 *
 * Idempotent on a missing anchor: callers may invoke this from the
 * `tauri://llm-complete` event handler regardless of whether
 * `_beginStream` was reached (e.g. the backend emitted a stray
 * complete in a torn-down state); without an anchor, this is a
 * no-op.
 *
 * The post-stream cursor/selection is captured via the same
 * UTF-16-to-codepoint translation as `_beginStream` so
 * `afterSelection` lives in code-point units, matching
 * `beforeSelection`.
 *
 * @returns {void}
 */
export function _completeStream() {
  const anchor = streamAnchor;
  if (anchor === null) {
    streamActive = false;
    return;
  }
  if (anchor.group.changes.length >= 1 && bufferEl) {
    // Capture the post-stream selection as the group's afterSelection
    // so a subsequent Undo can restore the pre-stream selection and a
    // subsequent Redo can restore this caret position.
    const value = bufferEl.value;
    const rawStart =
      typeof bufferEl.selectionStart === "number" ? bufferEl.selectionStart : 0;
    const rawEnd =
      typeof bufferEl.selectionEnd === "number"
        ? bufferEl.selectionEnd
        : rawStart;
    anchor.group.afterSelection = {
      start: utf16ToCodepoint(value, rawStart),
      end: utf16ToCodepoint(value, rawEnd),
    };
    pushUndo(anchor.group);
  }
  streamAnchor = null;
  streamActive = false;
}

/* ------------------------------------------------------------------ */
/* Undo / Redo stack helpers (Req 18.15, 18.18-18.20).                 */
/* ------------------------------------------------------------------ */

/**
 * FIFO push helper. When `stack` already holds the documented maximum
 * (`UNDO_REDO_CAPACITY`), the bottom-most (oldest) entry is dropped
 * before `group` is appended on top so the post-condition is exactly
 * `UNDO_REDO_CAPACITY` entries with `group` at index `length - 1`.
 *
 * @param {Array<object>} stack
 * @param {object} group
 * @returns {void}
 */
function pushOnto(stack, group) {
  if (stack.length >= UNDO_REDO_CAPACITY) {
    stack.shift();
  }
  stack.push(group);
}

/**
 * Push `group` onto `undoStack`. Per Req 18.15, every push from a
 * source other than Redo clears `redoStack`. Task 21's `redo()` will
 * call this with `{ fromRedo: true }` so the Redo-replay does not
 * clobber the rest of the redo-history.
 *
 * @param {object} group
 * @param {{ fromRedo?: boolean }} [opts]
 * @returns {void}
 */
function pushUndo(group, { fromRedo = false } = {}) {
  pushOnto(undoStack, group);
  if (!fromRedo) {
    redoStack.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Undo / Redo replay helpers (Req 18.11, 18.13).                      */
/*                                                                     */
/* Both helpers run a dry-pass that copies the buffer into a code-point*/
/* array and validates each change before mutating. On any mismatch    */
/* (out-of-range index, or `deleted`/`inserted` not actually present  */
/* at the recorded `at`), they return `null` so the caller can roll   */
/* back the popped group and surface the documented "undo/redo state */
/* desynchronized" message without leaving the buffer in a partial    */
/* state.                                                              */
/* ------------------------------------------------------------------ */

/**
 * Apply `changes` in original order: at each step, splice
 * `change.deleted` out and `change.inserted` in at `change.at` (in
 * code-point space). Returns the resulting buffer string on success,
 * or `null` if any change fails the bounds-check.
 *
 * The bounds-check verifies, for each change:
 *   - `at` is a non-negative integer no greater than the current
 *     code-point length;
 *   - `at + codepointLength(change.deleted)` does not exceed that
 *     length;
 *   - the substring from `at` to `at + codepointLength(deleted)` of
 *     the working buffer equals `change.deleted`.
 *
 * @param {string} value
 * @param {Array<{ at: number, deleted: string, inserted: string }>} changes
 * @returns {string | null}
 */
function _applyChangesForward(value, changes) {
  let cp = [...value];
  for (const change of changes) {
    if (!_validateChange(cp, change.at, change.deleted)) return null;
    const insArr = [...change.inserted];
    cp.splice(change.at, [...change.deleted].length, ...insArr);
  }
  return cp.join("");
}

/**
 * Apply `changes` in reverse order with `deleted`/`inserted` swapped:
 * at each step, splice `change.inserted` out and `change.deleted` in.
 * Returns the resulting buffer string on success, or `null` if any
 * change fails the bounds-check.
 *
 * The bounds-check verifies the substring from `at` to `at +
 * codepointLength(inserted)` of the working buffer equals
 * `change.inserted` — i.e., the change really was applied to the
 * buffer at the recorded position.
 *
 * @param {string} value
 * @param {Array<{ at: number, deleted: string, inserted: string }>} changes
 * @returns {string | null}
 */
function _applyChangesReverse(value, changes) {
  let cp = [...value];
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i];
    if (!_validateChange(cp, change.at, change.inserted)) return null;
    const delArr = [...change.deleted];
    cp.splice(change.at, [...change.inserted].length, ...delArr);
  }
  return cp.join("");
}

/**
 * Validate that `expected` lives at `[at, at + codepointLength(
 * expected))` of the code-point array `cp`. Returns true on a match,
 * false on any of: non-integer `at`, negative `at`, range overflow,
 * or content mismatch. Used by both replay directions.
 *
 * @param {string[]} cp Code-point array of the working buffer.
 * @param {number} at
 * @param {string} expected
 * @returns {boolean}
 */
function _validateChange(cp, at, expected) {
  if (!Number.isInteger(at) || at < 0) return false;
  const expArr = [...expected];
  if (at + expArr.length > cp.length) return false;
  for (let j = 0; j < expArr.length; j += 1) {
    if (cp[at + j] !== expArr[j]) return false;
  }
  return true;
}

/**
 * Restore `selection` (in code-point units, as recorded on the
 * `Edit_Group`) onto `bufferEl` after a successful replay. The DOM
 * speaks UTF-16, so we translate code-point indices back to UTF-16
 * indices using the current buffer text.
 *
 * Programmatic selection writes count as cursor jumps for the next
 * typed keystroke (Req 18.2): we set `cursorJumped = true` and update
 * `lastRecordedSelection` so any keystroke that follows the
 * undo/redo begins a new typing group rather than coalescing with
 * whatever was on top before.
 *
 * @param {{ source?: string }} _group
 * @param {{ start: number, end: number }} selection
 * @returns {void}
 */
function _restoreSelection(_group, selection) {
  if (!bufferEl) return;
  const value = bufferEl.value;
  const startUtf16 = _codepointToUtf16(value, selection.start);
  const endUtf16 = _codepointToUtf16(value, selection.end);
  bufferEl.selectionStart = startUtf16;
  bufferEl.selectionEnd = endUtf16;
  cursorJumped = true;
  lastRecordedSelection = { start: startUtf16, end: endUtf16 };
}

/**
 * Translate a code-point index to the matching UTF-16 index in `s`.
 * Inverse of `utf16ToCodepoint`. Indices past the end of the string
 * clamp to `s.length`.
 *
 * @param {string} s
 * @param {number} cpIndex
 * @returns {number}
 */
function _codepointToUtf16(s, cpIndex) {
  let count = 0;
  let i = 0;
  while (i < s.length && count < cpIndex) {
    const code = s.codePointAt(i);
    i += code !== undefined && code > 0xffff ? 2 : 1;
    count += 1;
  }
  return i;
}

/**
 * Surface the "undo/redo state desynchronized; please retry" message
 * in two places:
 *   - `console.error` (so devtools always have it);
 *   - a `CustomEvent("editor:status", { detail: { message } })` on
 *     `document` so `main.js` (or any subscriber) can re-render the
 *     Status_Bar with the error verbatim per Req 14.6 without us
 *     creating a circular import on `status_bar.js`.
 *
 * The literal message string is fixed by the task description and
 * MUST be surfaced exactly as documented.
 *
 * @param {"undo"|"redo"} which
 * @param {object} group
 * @returns {void}
 */
function _emitDesyncStatus(which, group) {
  const message = "undo/redo state desynchronized; please retry";
  // eslint-disable-next-line no-console
  console.error(`${which}: ${message}`, group);
  if (typeof document !== "undefined" && typeof CustomEvent === "function") {
    try {
      document.dispatchEvent(
        new CustomEvent("editor:status", { detail: { message } })
      );
    } catch {
      /* document may not accept custom events in some test envs */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Typed-input grouping (Req 18.2-18.4).                               */
/* ------------------------------------------------------------------ */

/**
 * Capture `bufferEl`'s current selection in UTF-16 indices (the units
 * the DOM reports). The undo machinery's selection bookkeeping does
 * not need code-point translation: every `EditGroup`'s before/after
 * selection is restored verbatim onto the textarea, which speaks
 * UTF-16 natively.
 *
 * Returns `{ start: 0, end: 0 }` when the buffer is unbound.
 *
 * @returns {{ start: number, end: number }}
 */
function _captureSelection() {
  if (!bufferEl) return { start: 0, end: 0 };
  const start =
    typeof bufferEl.selectionStart === "number" ? bufferEl.selectionStart : 0;
  const end =
    typeof bufferEl.selectionEnd === "number" ? bufferEl.selectionEnd : start;
  return { start, end };
}

/**
 * Record a typed-character keystroke (Req 18.2-18.4).
 *
 * Append to the topmost `EditGroup` if and only if every condition in
 * Req 18.2 holds:
 *   - the stack is non-empty and `top.source === "typing"`;
 *   - `Date.now() - top.lastAppendedAt <= 1000`;
 *   - no `cursorJumped` signal has fired since the previous append;
 *   - the current key is not Enter (Req 18.4 carves Enter out so it
 *     always begins a fresh group).
 *
 * Otherwise, push a new `"typing"` group onto `undoStack` containing
 * exactly the supplied change (Req 18.3).
 *
 * Enter clears `cursorJumped` after committing the keystroke
 * (Req 18.4 explicitly anchors the next coalescing window to the new
 * group rather than leaving a stale jump signal that would
 * immediately break the new group on the next keystroke).
 *
 * @param {KeyboardEvent | { key?: string }} keyEvent
 * @param {{
 *   at: number,
 *   deleted: string,
 *   inserted: string,
 *   beforeSelection: { start: number, end: number },
 *   afterSelection: { start: number, end: number },
 * }} change
 * @returns {void}
 */
export function recordTypedKeystroke(keyEvent, change) {
  if (streamActive) return; // Req 18.21 (consistent with the rest of edit pathways)
  const isEnter = keyEvent && keyEvent.key === "Enter";
  const top = undoStack[undoStack.length - 1];
  const now = Date.now();
  const canAppend =
    !isEnter &&
    !cursorJumped &&
    top !== undefined &&
    top.source === "typing" &&
    now - top.lastAppendedAt <= 1000;

  if (canAppend) {
    top.changes.push({
      at: change.at,
      deleted: change.deleted,
      inserted: change.inserted,
    });
    top.afterSelection = { ...change.afterSelection };
    top.lastAppendedAt = now;
  } else {
    const group = {
      source: "typing",
      beforeSelection: { ...change.beforeSelection },
      afterSelection: { ...change.afterSelection },
      changes: [
        {
          at: change.at,
          deleted: change.deleted,
          inserted: change.inserted,
        },
      ],
      lastAppendedAt: now,
    };
    pushUndo(group);
  }

  // The current keystroke has now been evaluated against the prior
  // jump signal; clear it so the next keystroke starts a new
  // window. Enter additionally always begins a new group, but the
  // post-clear is the same: the next keystroke evaluates against
  // the freshly pushed group with no carry-over jump.
  cursorJumped = false;
  lastRecordedSelection = { ...change.afterSelection };
}

/* ------------------------------------------------------------------ */
/* Paste / Cut handlers (Req 8.3, 8.4, 8.5, 18.5, 18.6).               */
/* ------------------------------------------------------------------ */

/**
 * Handle a `paste` event: pull the clipboard's plain-text payload,
 * splice it over the current selection, and push a single
 * `"paste"`-sourced `EditGroup` onto `undoStack` (Req 18.5).
 *
 * Empty clipboard text is a no-op and produces no group: there is no
 * Buffer mutation to record. We `preventDefault` so the splice we
 * perform is the authoritative one - jsdom (and some browsers in
 * specific configurations) would otherwise also splice via the
 * default action, double-applying the clipboard text.
 *
 * @param {ClipboardEvent} event
 * @returns {void}
 */
function _onPaste(event) {
  if (!bufferEl || streamActive) return;
  const cd = event.clipboardData || globalThis.clipboardData;
  if (!cd) return;
  const text = typeof cd.getData === "function" ? cd.getData("text/plain") : "";
  // Always preventDefault so the manual splice is the single source
  // of truth; otherwise the browser's built-in paste would race the
  // splice we record onto the undo stack.
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof text !== "string" || text.length === 0) return;

  const beforeSelection = _captureSelection();
  const start = beforeSelection.start;
  const end = beforeSelection.end;
  const value = bufferEl.value;
  const deleted = value.slice(start, end);
  const next = value.slice(0, start) + text + value.slice(end);
  bufferEl.value = next;
  const newCaret = start + text.length;
  bufferEl.selectionStart = newCaret;
  bufferEl.selectionEnd = newCaret;
  const afterSelection = { start: newCaret, end: newCaret };

  pushUndo({
    source: "paste",
    beforeSelection: { ...beforeSelection },
    afterSelection: { ...afterSelection },
    changes: [{ at: start, deleted, inserted: text }],
    lastAppendedAt: Date.now(),
  });

  // Programmatic selection write counts as a cursor jump for the
  // next typed keystroke (any subsequent typing should begin a new
  // group rather than coalesce with whatever was on top before).
  cursorJumped = true;
  lastRecordedSelection = { ...afterSelection };
  bufferEl.dispatchEvent(new Event("input"));
}

/**
 * Handle a `cut` event: a zero-length selection is a no-op (Req 8.4
 * + 18.6 precondition); a non-zero-length selection removes the
 * selected text from the Buffer, copies it to the clipboard, and
 * pushes a single `"cut"`-sourced `EditGroup` onto `undoStack`
 * (Req 18.6).
 *
 * @param {ClipboardEvent} event
 * @returns {void}
 */
function _onCut(event) {
  if (!bufferEl || streamActive) return;
  const beforeSelection = _captureSelection();
  if (beforeSelection.start === beforeSelection.end) {
    // Zero-length cut: leave the Buffer and clipboard unchanged
    // (Req 8.4) and produce no Edit_Group (Req 18.6 precondition).
    if (typeof event.preventDefault === "function") event.preventDefault();
    return;
  }
  const value = bufferEl.value;
  const deleted = value.slice(beforeSelection.start, beforeSelection.end);
  const next =
    value.slice(0, beforeSelection.start) + value.slice(beforeSelection.end);

  // Stage the deleted text into the clipboard and prevent the
  // browser's default cut path so our splice + group is the single
  // source of truth.
  const cd = event.clipboardData || globalThis.clipboardData;
  if (cd && typeof cd.setData === "function") {
    try {
      cd.setData("text/plain", deleted);
    } catch {
      /* clipboard write best-effort; the splice still proceeds */
    }
  }
  if (typeof event.preventDefault === "function") event.preventDefault();

  bufferEl.value = next;
  bufferEl.selectionStart = beforeSelection.start;
  bufferEl.selectionEnd = beforeSelection.start;
  const afterSelection = {
    start: beforeSelection.start,
    end: beforeSelection.start,
  };

  pushUndo({
    source: "cut",
    beforeSelection: { ...beforeSelection },
    afterSelection: { ...afterSelection },
    changes: [{ at: beforeSelection.start, deleted, inserted: "" }],
    lastAppendedAt: Date.now(),
  });

  cursorJumped = true;
  lastRecordedSelection = { ...afterSelection };
  bufferEl.dispatchEvent(new Event("input"));
}

/**
 * Handle a `copy` event: zero-length selection is a no-op (Req 8.4
 * - copy with a zero-length selection leaves the Buffer and clipboard
 * unchanged). Non-zero-length copies fall through to the host
 * platform's default clipboard behavior (Req 8.3) - no `EditGroup`
 * is pushed because copy never mutates the Buffer.
 *
 * @param {ClipboardEvent} event
 * @returns {void}
 */
function _onCopy(event) {
  if (!bufferEl) return;
  const sel = _captureSelection();
  if (sel.start === sel.end) {
    if (typeof event.preventDefault === "function") event.preventDefault();
  }
  // Non-zero-length copies: do nothing here, the browser default
  // clipboard write applies (Req 8.3). No undo/redo bookkeeping
  // because copy is non-mutating.
}

/* ------------------------------------------------------------------ */
/* DOM event wiring.                                                   */
/* ------------------------------------------------------------------ */

const CURSOR_JUMP_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * Determine whether `event` represents a "printable character" that
 * the user typed. We treat a `key` of length 1 as printable along
 * with `Enter` (which does not match the length-1 rule but is still
 * a text-modifying keystroke under Req 18.4).
 *
 * Filtering out modifier keys and navigation keys lets the typing
 * pipeline safely skip recording for Ctrl/Alt/Cmd-prefixed shortcuts
 * (those are handled by `menu.js`) and arrow/Home/End/Page navigation
 * (those just toggle `cursorJumped`).
 *
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
function _isPrintableTypedKey(e) {
  if (!e || typeof e.key !== "string") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "Enter") return true;
  return e.key.length === 1;
}

/**
 * Attach all DOM listeners that drive the typed-input grouping,
 * paste/cut pipelines, and `cursorJumped` flag. Returned teardowns
 * are stored on `listenerTeardowns` so a subsequent `initialize()`
 * call can detach them cleanly.
 *
 * @param {HTMLTextAreaElement} el
 * @returns {void}
 */
function _attachEventListeners(el) {
  const onKeydown = (e) => {
    // Cursor-moving keys: flip the jump flag so any in-flight typing
    // group is broken on the next keystroke (Req 18.2).
    if (CURSOR_JUMP_KEYS.has(e.key)) {
      cursorJumped = true;
      // The selection will move on the *default* action of this
      // event; we record the new selection on the followup
      // `select`/`keyup` cycle, not here.
      return;
    }

    if (streamActive) return;

    // For typed printable characters and Enter, record the
    // resulting Buffer mutation against the typed-input grouping
    // rules. The keystroke's actual splice is performed by the
    // browser's default action; we observe it by snapshotting the
    // pre/post-event state around the synchronous default. To do
    // that reliably without racing the default, we capture the
    // pre-state here and finish the recording from a `beforeinput`
    // listener that runs *before* the splice and an `input`
    // listener that runs *after*.
    //
    // Implementation note: the `keydown` path stays light — the
    // before/after capture lives in the `beforeinput` + `input`
    // pair below, which sees both the typed character (via
    // `inputType === "insertText"` / `"insertLineBreak"`) and the
    // resulting buffer state.
    if (_isPrintableTypedKey(e)) {
      // Stash the latest typed key on a private slot so
      // `_onInputForTyping` can pair it with the splice.
      _pendingTypedKey = e;
    }
  };

  const onBeforeInput = (e) => {
    // History intercepts (Req 18.21 + design.md "Intercepting the
    // textarea's built-in undo/redo"): always preventDefault so the
    // browser's private history never runs, and route to our
    // module-level undo()/redo() which themselves no-op while a
    // stream is active.
    if (e.inputType === "historyUndo") {
      if (typeof e.preventDefault === "function") e.preventDefault();
      undo();
      return;
    }
    if (e.inputType === "historyRedo") {
      if (typeof e.preventDefault === "function") e.preventDefault();
      redo();
      return;
    }
    if (streamActive) return;
    // Capture pre-state for any `insertText` / `insertLineBreak`
    // event so the post-`input` listener can compute the
    // `{ at, deleted, inserted }` change record.
    if (
      e.inputType === "insertText" ||
      e.inputType === "insertLineBreak" ||
      e.inputType === "insertParagraph"
    ) {
      _pendingTypedSnapshot = {
        value: el.value,
        selection: _captureSelection(),
      };
    }
  };

  const onInput = (e) => {
    if (streamActive) return;
    if (!_pendingTypedSnapshot) return;
    if (
      e.inputType !== "insertText" &&
      e.inputType !== "insertLineBreak" &&
      e.inputType !== "insertParagraph"
    ) {
      _pendingTypedSnapshot = null;
      _pendingTypedKey = null;
      return;
    }
    const before = _pendingTypedSnapshot;
    _pendingTypedSnapshot = null;
    const keyEvent = _pendingTypedKey || { key: e.data || "" };
    _pendingTypedKey = null;

    const { value: prevValue, selection: prevSel } = before;
    const nextValue = el.value;
    const at = prevSel.start;
    const deleted = prevValue.slice(prevSel.start, prevSel.end);
    // Inserted = the substring of `nextValue` that lives at `at`
    // and has the length implied by the new selection's caret
    // position.
    const afterSel = _captureSelection();
    const insertedLen = afterSel.start - at;
    const inserted = insertedLen >= 0 ? nextValue.slice(at, at + insertedLen) : "";

    recordTypedKeystroke(keyEvent, {
      at,
      deleted,
      inserted,
      beforeSelection: prevSel,
      afterSelection: afterSel,
    });
  };

  const onMousedown = () => {
    cursorJumped = true;
  };
  const onClick = () => {
    cursorJumped = true;
  };
  const onSelect = () => {
    const sel = _captureSelection();
    if (
      sel.start !== lastRecordedSelection.start ||
      sel.end !== lastRecordedSelection.end
    ) {
      cursorJumped = true;
      lastRecordedSelection = { ...sel };
    }
  };

  el.addEventListener("keydown", onKeydown);
  el.addEventListener("beforeinput", onBeforeInput);
  el.addEventListener("input", onInput);
  el.addEventListener("mousedown", onMousedown);
  el.addEventListener("click", onClick);
  el.addEventListener("select", onSelect);
  el.addEventListener("paste", _onPaste);
  el.addEventListener("cut", _onCut);
  el.addEventListener("copy", _onCopy);

  listenerTeardowns.push(
    () => el.removeEventListener("keydown", onKeydown),
    () => el.removeEventListener("beforeinput", onBeforeInput),
    () => el.removeEventListener("input", onInput),
    () => el.removeEventListener("mousedown", onMousedown),
    () => el.removeEventListener("click", onClick),
    () => el.removeEventListener("select", onSelect),
    () => el.removeEventListener("paste", _onPaste),
    () => el.removeEventListener("cut", _onCut),
    () => el.removeEventListener("copy", _onCopy)
  );
}

// Pre/post-input snapshot pairing for the typed-keystroke pipeline.
let _pendingTypedSnapshot = null;
let _pendingTypedKey = null;

/* ------------------------------------------------------------------ */
/* Open File post-resolution helper (Req 18.16).                       */
/* ------------------------------------------------------------------ */

/**
 * Replace the buffer with the contents loaded for `path`, refresh the
 * saved snapshot so dirty-flag returns to false (Req 8.7), and clear
 * both undo and redo stacks per Req 18.16.
 *
 * Used by both the `tauri://file-opened` handler (wired in Task 24
 * via `main.js`) and the local `openFile()` resolution path so the
 * stack-clearing rule applies regardless of whether the open was
 * driven by the menu picker or by a backend-emitted event.
 *
 * @param {string} contents
 * @param {string | null} path
 * @returns {void}
 */
export function _replaceBufferOnOpen(contents, path) {
  if (!bufferEl) return;
  bufferEl.value = typeof contents === "string" ? contents : "";
  savedSnapshot = bufferEl.value;
  currentPath = typeof path === "string" && path.length > 0 ? path : null;
  // Req 18.16: a successful Open File clears both stacks.
  undoStack.length = 0;
  redoStack.length = 0;
  // Programmatic selection write counts as a cursor jump.
  bufferEl.selectionStart = 0;
  bufferEl.selectionEnd = 0;
  cursorJumped = true;
  lastRecordedSelection = { start: 0, end: 0 };
  bufferEl.dispatchEvent(new Event("input"));
}



/**
 * Test hook: expose the captured buffer element so unit tests can
 * verify `initialize()` ran.
 *
 * @returns {HTMLTextAreaElement | null}
 */
export function _bufferElForTests() {
  return bufferEl;
}

/**
 * Test hook: snapshot the current stream anchor (or null). Useful for
 * asserting `insertedLength` and the in-progress `Edit_Group` shape.
 *
 * @returns {object | null}
 */
export function _streamAnchorForTests() {
  return streamAnchor;
}

/**
 * Test hook: directly set the saved snapshot so dirty-flag tests can
 * exercise the Req 8.7 "back-to-saved clears dirty" branch without
 * driving a real Open/Save flow.
 *
 * @param {string} snapshot
 * @returns {void}
 */
export function _setSavedSnapshotForTests(snapshot) {
  savedSnapshot = snapshot;
}

/**
 * Test hook: read the unexposed module state so tests can confirm the
 * Task 18 fields exist with the documented defaults. Returned object
 * is a fresh shallow copy.
 *
 * @returns {{
 *   currentPath: string | null,
 *   savedSnapshot: string,
 *   hadBom: boolean,
 *   lineEnding: string,
 *   streamActive: boolean,
 * }}
 */
export function _stateForTests() {
  return { currentPath, savedSnapshot, hadBom, lineEnding, streamActive };
}

/**
 * Test hook: snapshot the undo/redo stacks. Returned object is a
 * shallow copy so test mutations cannot leak into module state.
 *
 * @returns {{
 *   undoStack: Array<object>,
 *   redoStack: Array<object>,
 *   capacity: number,
 *   cursorJumped: boolean,
 * }}
 */
export function _undoRedoStateForTests() {
  return {
    undoStack: undoStack.slice(),
    redoStack: redoStack.slice(),
    capacity: UNDO_REDO_CAPACITY,
    cursorJumped,
  };
}

/**
 * Test hook: directly set the `cursorJumped` flag. Lets tests force
 * the typed-input grouping to break on the next keystroke without
 * having to dispatch a synthesized cursor-jump event.
 *
 * @param {boolean} v
 * @returns {void}
 */
export function _setCursorJumpedForTests(v) {
  cursorJumped = Boolean(v);
}

/**
 * Test hook: directly seed the `undoStack` so undo/redo unit tests
 * can drive scenarios without first replaying every keystroke.
 *
 * @param {Array<object>} groups
 * @returns {void}
 */
export function _setUndoStackForTests(groups) {
  undoStack.length = 0;
  for (const g of groups) undoStack.push(g);
}

/**
 * Test hook: directly seed the `redoStack` (paired with
 * `_setUndoStackForTests`).
 *
 * @param {Array<object>} groups
 * @returns {void}
 */
export function _setRedoStackForTests(groups) {
  redoStack.length = 0;
  for (const g of groups) redoStack.push(g);
}

/**
 * Test hook: expose the `pushUndo` / `pushOnto` / `recordTypedKeystroke`
 * helpers so capacity and grouping tests can drive the pipeline
 * without a real DOM `input` event.
 */
export const _undoRedoInternals = {
  pushOnto: (stack, group) => pushOnto(stack, group),
  pushUndo: (group, opts) => pushUndo(group, opts),
};
