// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — status_bar.js
//
// Renders the bottom status bar: file path (or "Untitled"), dirty
// asterisk, character count, model name (or "(no model)"), and any
// transient error reason. The status bar is the only UI surface for
// backend / stream errors (Req 14.6); error reasons are rendered
// verbatim with no transformation.
//
// Format (Req 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, 14.6):
//
//     {*?}{path | "Untitled"}  •  {n} chars  •  {model | "(no model)"}[  •  {error}]
//
// The dirty asterisk has *no intervening characters* between it and
// the path/Untitled text (Req 9.6). The "•" bullet separator is the
// design's choice (design.md "status_bar.js"); only the asterisk-
// adjacency rule is normative.
//
// Character count is the number of Unicode code points in the current
// buffer, not the UTF-16 code unit count (Req 9.3, 8.8). The
// `attachToBuffer` helper wires an `input` event listener that
// re-renders the status bar synchronously so the displayed count is
// always in sync with the textarea before the browser processes the
// next user-input event (Req 8.8).
//
// `main.js` re-renders the status bar after every settings warm-up and
// every successful `save_settings` so the model name updates within
// the Req 9.5 budget (200ms): the re-render is synchronous on the
// success path of the save, far below the budget.

const STATUS_BAR_ID = "status-bar";
const SEPARATOR = "  •  ";
const UNTITLED = "Untitled";
const NO_MODEL = "(no model)";

/**
 * Count the Unicode code points in `s`.
 *
 * `String.prototype[@@iterator]` walks code points (surrogate pairs
 * yield a single iteration), so `[...s].length` is the code-point
 * count regardless of UTF-16 representation. This matches the file-
 * service's `chars().count()` on the Rust side and the Req 9.3 / 8.8
 * unit ("Unicode code points").
 *
 * @param {string} s
 * @returns {number}
 */
function codePointLength(s) {
  if (typeof s !== "string" || s.length === 0) return 0;
  // Fast path: pure ASCII / BMP-only strings have equal code-unit and
  // code-point counts. Detect a surrogate via a single scan; only fall
  // back to the iterator when one is present.
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
 * Resolve the displayed path segment, including the dirty asterisk.
 * The asterisk is concatenated with no separator so Req 9.6 holds even
 * for the "Untitled" buffer (e.g. `*Untitled`). Req 9.7 is satisfied
 * by simply omitting the asterisk when `dirty` is falsy.
 *
 * @param {string|null|undefined} path
 * @param {boolean|undefined} dirty
 * @returns {string}
 */
function formatPathSegment(path, dirty) {
  const text = typeof path === "string" && path.length > 0 ? path : UNTITLED;
  return (dirty ? "*" : "") + text;
}

/**
 * Resolve the displayed model segment (Req 9.4). An empty string,
 * `null`, `undefined`, or any non-string value all collapse to the
 * literal `"(no model)"`. Whitespace-only values are not collapsed —
 * the requirement only special-cases the empty string, and a
 * whitespace name is something the user explicitly entered in the
 * Settings_Modal.
 *
 * @param {string|null|undefined} model
 * @returns {string}
 */
function formatModelSegment(model) {
  return typeof model === "string" && model.length > 0 ? model : NO_MODEL;
}

/**
 * Format the full status-bar string for the given state. Exposed for
 * testing the formatting rules without a DOM (the public API is
 * `renderStatusBar`, which writes the same string into the footer).
 *
 * @param {{
 *   path?: string|null,
 *   charCount?: number,
 *   model?: string|null,
 *   dirty?: boolean,
 *   error?: string|null,
 * }} state
 * @returns {string}
 */
export function formatStatusBar(state = {}) {
  const pathSeg = formatPathSegment(state.path, state.dirty);
  const count = Number.isFinite(state.charCount)
    ? Math.max(0, Math.trunc(state.charCount))
    : 0;
  const modelSeg = formatModelSegment(state.model);
  let text = `${pathSeg}${SEPARATOR}${count} chars${SEPARATOR}${modelSeg}`;
  if (typeof state.error === "string" && state.error.length > 0) {
    text += `${SEPARATOR}${state.error}`;
  }
  return text;
}

/**
 * Write the formatted status bar contents into `<footer id="status-bar">`.
 *
 * The footer is looked up by id every call so the function works
 * whether or not the DOM has been fully constructed when the caller
 * invokes it. When the footer is missing (e.g. a unit test that has
 * not installed the markup), the call is a silent no-op.
 *
 * @param {{
 *   path?: string|null,
 *   charCount?: number,
 *   model?: string|null,
 *   dirty?: boolean,
 *   error?: string|null,
 * }} [state]
 */
export function renderStatusBar(state = {}) {
  const footer =
    typeof document !== "undefined"
      ? document.getElementById(STATUS_BAR_ID)
      : null;
  if (!footer) return;
  footer.textContent = formatStatusBar(state);
}

/**
 * Wire `bufferEl`'s `input` event so the status bar re-renders
 * synchronously on every buffer change (Req 8.8). `getState` is a
 * caller-supplied accessor that returns the current
 * `renderStatusBar` argument bag — main.js owns the canonical state
 * (path, model, dirty, error), and this module re-derives `charCount`
 * from the textarea on each event.
 *
 * The listener calls `renderStatusBar(getState())` directly without a
 * `requestAnimationFrame` / `setTimeout` indirection so the displayed
 * count is updated before the browser processes the next user-input
 * event (Req 8.8). When `getState` is omitted or returns a non-object
 * we still render with the live char count so the basic bar stays in
 * sync.
 *
 * Returns a teardown function that detaches the listener; tests use
 * this so a per-test `attachToBuffer` does not leak listeners across
 * cases.
 *
 * @param {HTMLElement} bufferEl
 * @param {() => object} [getState]
 * @returns {() => void}
 */
export function attachToBuffer(bufferEl, getState) {
  if (!bufferEl || typeof bufferEl.addEventListener !== "function") {
    return () => {};
  }
  const handler = () => {
    let base = {};
    if (typeof getState === "function") {
      try {
        const s = getState();
        if (s && typeof s === "object") base = s;
      } catch {
        // Swallow: a status-bar render failure must never block
        // editor input. The bar simply renders with defaults.
        base = {};
      }
    }
    const charCount = codePointLength(
      typeof bufferEl.value === "string" ? bufferEl.value : ""
    );
    renderStatusBar({ ...base, charCount });
  };
  bufferEl.addEventListener("input", handler);
  return () => bufferEl.removeEventListener("input", handler);
}

// Test-only escape hatches. Marked with the `_` prefix so callers can
// see at a glance that they are not part of the public API.
export const _internal = { codePointLength, formatStatusBar };
