// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — status_bar.js

const STATUS_BAR_ID = "status-bar";
const STATUS_PATH_ID = "status-path";
const STATUS_CURSOR_ID = "status-cursor";
const STATUS_MODEL_ID = "status-model";
const UNTITLED = "Untitled";
const NO_MODEL = "(no model)";

/**
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
 * @param {string|null|undefined} path
 * @param {boolean|undefined} dirty
 * @returns {string}
 */
function formatPathSegment(path, dirty) {
  const text = typeof path === "string" && path.length > 0 ? path : UNTITLED;
  return (dirty ? "*" : "") + text;
}

/**
 * @param {string|null|undefined} model
 * @returns {string}
 */
function formatModelSegment(model) {
  return typeof model === "string" && model.length > 0 ? model : NO_MODEL;
}

/**
 * @param {number} line
 * @param {number} column
 * @param {number} charCount
 * @param {string|null|undefined} error
 * @returns {string}
 */
function formatCursorSegment(line, column, charCount, error) {
  const count = Number.isFinite(charCount) ? Math.max(0, Math.trunc(charCount)) : 0;
  const ln = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
  const col = Number.isFinite(column) ? Math.max(1, Math.trunc(column)) : 1;
  let text = `Ln ${ln}, Col ${col}  ·  ${count.toLocaleString()} chars`;
  if (typeof error === "string" && error.length > 0) {
    text += `  ·  ${error}`;
  }
  return text;
}

/**
 * @param {{
 *   path?: string|null,
 *   charCount?: number,
 *   model?: string|null,
 *   dirty?: boolean,
 *   error?: string|null,
 *   line?: number,
 *   column?: number,
 * }} state
 * @returns {string}
 */
export function formatStatusBar(state = {}) {
  const pathSeg = formatPathSegment(state.path, state.dirty);
  const cursorSeg = formatCursorSegment(
    state.line ?? 1,
    state.column ?? 1,
    state.charCount,
    state.error
  );
  const modelSeg = formatModelSegment(state.model);
  return `${pathSeg}  ·  ${cursorSeg}  ·  ${modelSeg}`;
}

/**
 * @param {{
 *   path?: string|null,
 *   charCount?: number,
 *   model?: string|null,
 *   dirty?: boolean,
 *   error?: string|null,
 *   line?: number,
 *   column?: number,
 * }} [state]
 * @returns {void}
 */
export function renderStatusBar(state = {}) {
  if (typeof document === "undefined") return;

  const footer = document.getElementById(STATUS_BAR_ID);
  const pathEl = document.getElementById(STATUS_PATH_ID);
  const cursorEl = document.getElementById(STATUS_CURSOR_ID);
  const modelEl = document.getElementById(STATUS_MODEL_ID);

  const pathText = formatPathSegment(state.path, state.dirty);
  const cursorText = formatCursorSegment(
    state.line ?? 1,
    state.column ?? 1,
    state.charCount,
    state.error
  );
  const modelText = formatModelSegment(state.model);

  if (pathEl && cursorEl && modelEl) {
    pathEl.textContent = pathText;
    pathEl.classList.toggle("status-dirty", state.dirty === true);
    cursorEl.textContent = cursorText;
    cursorEl.classList.toggle(
      "status-error",
      typeof state.error === "string" && state.error.length > 0
    );
    modelEl.textContent = modelText;
    return;
  }

  if (footer) {
    footer.textContent = formatStatusBar(state);
  }
}

/**
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

export const _internal = {
  codePointLength,
  formatStatusBar,
  formatPathSegment,
  formatCursorSegment,
};
