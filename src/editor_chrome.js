// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Line numbers, column ruler, cursor position, and ghost selection overlay
// while the user is typing in the chat panel.

import { selectionLineRange } from "./context_window.js";

const RULER_LABELS =
  "    5    10    15    20    25    30    35    40    45    50    55    60    65    70";

let bufferEl = null;
let gutterEl = null;
let overlayEl = null;
let editorBodyEl = null;
let onCursorChange = null;
let ghostSelectionActive = false;
/** @type {{ start: number, end: number }} */
let pinnedSelection = { start: 0, end: 0 };
/** @type {number | null} */
let charWidthCache = null;

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
 * @param {number} offset UTF-16 index
 * @returns {{ line: number, col: number }}
 */
function offsetToLineCol(value, offset) {
  const clamped = Math.max(0, Math.min(offset, value.length));
  const before = value.slice(0, clamped);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  const col = clamped - (lastBreak === -1 ? 0 : lastBreak + 1);
  return { line, col };
}

/**
 * @param {string} value
 * @param {number} line 1-based
 * @returns {number} UTF-16 length of that line (excluding newline)
 */
function lineUtf16Length(value, line) {
  const lines = value.split("\n");
  const idx = Math.max(0, Math.min(line - 1, lines.length - 1));
  return lines[idx]?.length ?? 0;
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @returns {number}
 */
function measureCharWidth(textarea) {
  if (charWidthCache !== null) return charWidthCache;
  if (typeof document === "undefined") return 8;
  const probe = document.createElement("span");
  probe.textContent = "MMMMMMMMMM";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  const style = getComputedStyle(textarea);
  probe.style.font = style.font;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  charWidthCache = Number.isFinite(width) && width > 0 ? width : 8;
  return charWidthCache;
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {number} start
 * @param {number} end
 * @returns {Array<{ top: number, left: number, width: number, height: number, kind: "selection" | "caret" }>}
 */
export function selectionOverlayRects(textarea, start, end) {
  const value = typeof textarea.value === "string" ? textarea.value : "";
  const style = getComputedStyle(textarea);
  const lineHeight =
    Number.parseFloat(style.lineHeight) ||
    Number.parseFloat(style.fontSize) * 1.4 ||
    20;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const charWidth = measureCharWidth(textarea);
  const scrollTop = textarea.scrollTop;
  const scrollLeft = textarea.scrollLeft;

  const selStart = Math.max(0, Math.min(start, value.length));
  const selEnd = Math.max(0, Math.min(end, value.length));
  const rangeStart = Math.min(selStart, selEnd);
  const rangeEnd = Math.max(selStart, selEnd);

  if (rangeStart === rangeEnd) {
    const { line, col } = offsetToLineCol(value, rangeStart);
    return [
      {
        top: paddingTop + (line - 1) * lineHeight - scrollTop,
        left: paddingLeft + col * charWidth - scrollLeft,
        width: 2,
        height: lineHeight,
        kind: "caret",
      },
    ];
  }

  const startPos = offsetToLineCol(value, rangeStart);
  const endPos = offsetToLineCol(value, rangeEnd);
  /** @type {Array<{ top: number, left: number, width: number, height: number, kind: "selection" | "caret" }>} */
  const rects = [];

  for (let line = startPos.line; line <= endPos.line; line += 1) {
    const lineStartCol = line === startPos.line ? startPos.col : 0;
    const lineEndCol =
      line === endPos.line ? endPos.col : lineUtf16Length(value, line);
    const width = Math.max(1, (lineEndCol - lineStartCol) * charWidth);
    rects.push({
      top: paddingTop + (line - 1) * lineHeight - scrollTop,
      left: paddingLeft + lineStartCol * charWidth - scrollLeft,
      width,
      height: lineHeight,
      kind: "selection",
    });
  }

  return rects;
}

/**
 * @param {string} value
 * @param {number} activeLine
 * @param {number} selectionStartLine
 * @param {number} selectionEndLine
 * @param {boolean} hasSelection
 * @returns {string}
 */
function renderLineNumbers(
  value,
  activeLine,
  selectionStartLine,
  selectionEndLine,
  hasSelection
) {
  const lines = Math.max(1, value.split("\n").length);
  const rows = [];
  for (let i = 1; i <= lines; i += 1) {
    if (hasSelection && i >= selectionStartLine && i <= selectionEndLine) {
      rows.push(`<span class="line-selected">${i}</span>`);
    } else if (i === activeLine) {
      rows.push(`<span class="line-active">${i}</span>`);
    } else {
      rows.push(String(i));
    }
  }
  return rows.join("\n");
}

/**
 * @returns {boolean}
 */
function isChatFocused() {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  const chatPanel = document.getElementById("chat-panel");
  return Boolean(active && chatPanel && chatPanel.contains(active));
}

/**
 * @returns {void}
 */
function captureSelection() {
  if (!bufferEl) return;
  const start =
    typeof bufferEl.selectionStart === "number" ? bufferEl.selectionStart : 0;
  const end =
    typeof bufferEl.selectionEnd === "number" ? bufferEl.selectionEnd : start;
  pinnedSelection = { start, end };
}

/**
 * @param {boolean} active
 * @returns {void}
 */
function setGhostSelectionActive(active) {
  ghostSelectionActive = active;
  if (editorBodyEl) {
    editorBodyEl.classList.toggle("show-ghost-selection", active);
  }
  if (overlayEl) {
    overlayEl.classList.toggle("is-visible", active);
  }
}

/**
 * @returns {void}
 */
function renderGhostOverlay() {
  if (!bufferEl || !overlayEl || !ghostSelectionActive) {
    if (overlayEl) overlayEl.replaceChildren();
    return;
  }

  const rects = selectionOverlayRects(
    bufferEl,
    pinnedSelection.start,
    pinnedSelection.end
  );
  overlayEl.replaceChildren();
  for (const rect of rects) {
    const el = document.createElement("div");
    el.className =
      rect.kind === "caret" ? "ghost-caret" : "ghost-selection-rect";
    el.style.top = `${rect.top}px`;
    el.style.left = `${rect.left}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    overlayEl.appendChild(el);
  }
}

/**
 * @returns {void}
 */
function refreshChrome() {
  if (!bufferEl || !gutterEl) return;
  const value = typeof bufferEl.value === "string" ? bufferEl.value : "";
  const usePinned = ghostSelectionActive || document.activeElement !== bufferEl;
  const selStart = usePinned
    ? pinnedSelection.start
    : typeof bufferEl.selectionStart === "number"
      ? bufferEl.selectionStart
      : 0;
  const selEnd = usePinned
    ? pinnedSelection.end
    : typeof bufferEl.selectionEnd === "number"
      ? bufferEl.selectionEnd
      : selStart;
  const { startLine, endLine, hasSelection } = selectionLineRange(
    value,
    selStart,
    selEnd
  );
  const pos = cursorPosition(value, selStart);
  gutterEl.innerHTML = renderLineNumbers(
    value,
    pos.line,
    startLine,
    endLine,
    hasSelection
  );
  if (typeof onCursorChange === "function") {
    onCursorChange(pos);
  }
  renderGhostOverlay();
}

/**
 * @returns {void}
 */
function syncGhostState() {
  captureSelection();
  const shouldShow = isChatFocused();
  setGhostSelectionActive(shouldShow);
  refreshChrome();
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
  overlayEl = document.getElementById("selection-overlay");
  editorBodyEl = document.getElementById("editor-body");
  onCursorChange = opts.onCursorChange ?? null;
  charWidthCache = null;

  const labels = document.querySelector(".column-ruler-labels");
  if (labels) labels.textContent = RULER_LABELS;

  if (!bufferEl || !gutterEl) return () => {};

  const syncScroll = () => {
    gutterEl.scrollTop = bufferEl.scrollTop;
    if (ghostSelectionActive) renderGhostOverlay();
  };

  const handler = () => {
    if (document.activeElement === bufferEl) {
      captureSelection();
      setGhostSelectionActive(false);
    }
    refreshChrome();
  };

  const onBufferFocus = () => {
    setGhostSelectionActive(false);
    refreshChrome();
  };

  const onBufferBlur = () => {
    captureSelection();
    if (isChatFocused()) {
      setGhostSelectionActive(true);
    }
    refreshChrome();
  };

  const onChatFocusIn = () => {
    captureSelection();
    setGhostSelectionActive(true);
    refreshChrome();
  };

  const onChatFocusOut = () => {
    window.setTimeout(() => {
      if (document.activeElement === bufferEl) {
        setGhostSelectionActive(false);
      } else if (!isChatFocused()) {
        setGhostSelectionActive(false);
      }
      refreshChrome();
    }, 0);
  };

  const chatPanel = document.getElementById("chat-panel");

  bufferEl.addEventListener("input", handler);
  bufferEl.addEventListener("click", handler);
  bufferEl.addEventListener("keyup", handler);
  bufferEl.addEventListener("select", handler);
  bufferEl.addEventListener("scroll", syncScroll);
  bufferEl.addEventListener("focus", onBufferFocus);
  bufferEl.addEventListener("blur", onBufferBlur);
  if (chatPanel) {
    chatPanel.addEventListener("focusin", onChatFocusIn);
    chatPanel.addEventListener("focusout", onChatFocusOut);
  }
  window.addEventListener("resize", refreshChrome);

  captureSelection();
  refreshChrome();

  return () => {
    bufferEl.removeEventListener("input", handler);
    bufferEl.removeEventListener("click", handler);
    bufferEl.removeEventListener("keyup", handler);
    bufferEl.removeEventListener("select", handler);
    bufferEl.removeEventListener("scroll", syncScroll);
    bufferEl.removeEventListener("focus", onBufferFocus);
    bufferEl.removeEventListener("blur", onBufferBlur);
    if (chatPanel) {
      chatPanel.removeEventListener("focusin", onChatFocusIn);
      chatPanel.removeEventListener("focusout", onChatFocusOut);
    }
    window.removeEventListener("resize", refreshChrome);
    setGhostSelectionActive(false);
    bufferEl = null;
    gutterEl = null;
    overlayEl = null;
    editorBodyEl = null;
    onCursorChange = null;
    charWidthCache = null;
  };
}

export const _internal = {
  codePointLength,
  utf16ToCodepoint,
  cursorPosition,
  renderLineNumbers,
  offsetToLineCol,
  selectionOverlayRects,
  isChatFocused,
  syncGhostState,
};
