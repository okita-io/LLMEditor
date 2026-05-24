// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Line numbers, column ruler, and cursor position for the document editor.

const RULER_LABELS =
  "    5    10    15    20    25    30    35    40    45    50    55    60    65    70";

let bufferEl = null;
let gutterEl = null;
let onCursorChange = null;

/**
 * @param {number} value
 * @returns {number}
 */
function codePointLength(value) {
  if (typeof value !== "string" || value.length === 0) return 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      let count = 0;
      // eslint-disable-next-line no-unused-vars
      for (const _ of value) count += 1;
      return count;
    }
  }
  return value.length;
}

/**
 * @param {string} value
 * @param {number} utf16Index
 * @returns {number}
 */
function utf16ToCodepoint(value, utf16Index) {
  let cp = 0;
  let i = 0;
  while (i < value.length && i < utf16Index) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      i += 2;
    } else {
      i += 1;
    }
    cp += 1;
  }
  return cp;
}

/**
 * @param {string} value
 * @param {number} caret
 * @returns {{ line: number, column: number }}
 */
export function cursorPosition(value, caret) {
  const text = typeof value === "string" ? value : "";
  const index =
    typeof caret === "number" && Number.isFinite(caret)
      ? Math.max(0, Math.min(caret, text.length))
      : 0;

  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  const lineStart = lastBreak === -1 ? 0 : lastBreak + 1;
  const column = codePointLength(text.slice(lineStart, index)) + 1;
  return { line, column };
}

/**
 * @param {string} value
 * @param {number} activeLine
 * @returns {string}
 */
function renderLineNumbers(value, activeLine) {
  const lines = Math.max(1, value.split("\n").length);
  const rows = [];
  for (let i = 1; i <= lines; i += 1) {
    rows.push(i === activeLine ? `<span class="line-active">${i}</span>` : String(i));
  }
  return rows.join("\n");
}

/**
 * @returns {void}
 */
function refreshChrome() {
  if (!bufferEl || !gutterEl) return;
  const value = typeof bufferEl.value === "string" ? bufferEl.value : "";
  const caret =
    typeof bufferEl.selectionStart === "number" ? bufferEl.selectionStart : 0;
  const pos = cursorPosition(value, caret);
  gutterEl.innerHTML = renderLineNumbers(value, pos.line);
  if (typeof onCursorChange === "function") {
    onCursorChange(pos);
  }
}

/**
 * @param {HTMLElement} buffer
 * @param {{ onCursorChange?: (pos: { line: number, column: number }) => void }} [opts]
 * @returns {() => void}
 */
export function attachEditorChrome(buffer, opts = {}) {
  if (typeof document === "undefined") return () => {};
  bufferEl = buffer;
  gutterEl = document.getElementById("line-gutter");
  onCursorChange = opts.onCursorChange ?? null;

  const labels = document.querySelector(".column-ruler-labels");
  if (labels) labels.textContent = RULER_LABELS;

  if (!bufferEl || !gutterEl) return () => {};

  const syncScroll = () => {
    gutterEl.scrollTop = bufferEl.scrollTop;
  };

  const handler = () => refreshChrome();
  bufferEl.addEventListener("input", handler);
  bufferEl.addEventListener("click", handler);
  bufferEl.addEventListener("keyup", handler);
  bufferEl.addEventListener("select", handler);
  bufferEl.addEventListener("scroll", syncScroll);

  refreshChrome();

  return () => {
    bufferEl.removeEventListener("input", handler);
    bufferEl.removeEventListener("click", handler);
    bufferEl.removeEventListener("keyup", handler);
    bufferEl.removeEventListener("select", handler);
    bufferEl.removeEventListener("scroll", syncScroll);
    bufferEl = null;
    gutterEl = null;
    onCursorChange = null;
  };
}

export const _internal = {
  codePointLength,
  utf16ToCodepoint,
  cursorPosition,
  renderLineNumbers,
};
