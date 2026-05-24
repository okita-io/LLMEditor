// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Sliding line-based context window around the editor selection or caret.

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitLines(value) {
  if (typeof value !== "string") return [""];
  if (value.length === 0) return [""];
  return value.split("\n");
}

/** Send the full document when it fits within this many lines. */
export const MAX_FULL_DOC_LINES = 120;

/** Lines of context included before the anchor range. */
export const DEFAULT_LINES_BEFORE = 50;

/** Lines of context included after the anchor range. */
export const DEFAULT_LINES_AFTER = 50;

/**
 * @param {string} text
 * @param {number} offset UTF-16 index into `text`
 * @returns {number} 1-based line number
 */
export function lineAtOffset(text, offset) {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/**
 * @param {string} text
 * @param {number} selStart
 * @param {number} selEnd
 * @returns {{ startLine: number, endLine: number, hasSelection: boolean, selectedText: string }}
 */
export function selectionLineRange(text, selStart, selEnd) {
  const start = Math.max(0, selStart);
  const end = Math.max(start, selEnd);
  const hasSelection = start !== end;
  const startLine = lineAtOffset(text, start);
  const endLine = hasSelection
    ? lineAtOffset(text, end > 0 ? end - 1 : 0)
    : startLine;
  const selectedText = hasSelection ? text.slice(start, end) : "";
  return { startLine, endLine, hasSelection, selectedText };
}

/**
 * @param {string[]} lines
 * @param {number} windowStartLine 1-based inclusive
 * @param {number} windowEndLine 1-based inclusive
 * @param {number} selectionStartLine 1-based inclusive
 * @param {number} selectionEndLine 1-based inclusive
 * @param {boolean} hasSelection
 * @returns {string}
 */
export function formatNumberedWindow(
  lines,
  windowStartLine,
  windowEndLine,
  selectionStartLine,
  selectionEndLine,
  hasSelection
) {
  const parts = [];
  for (let lineNo = windowStartLine; lineNo <= windowEndLine; lineNo += 1) {
    const lineText = lines[lineNo - 1] ?? "";
    const inSelection =
      hasSelection && lineNo >= selectionStartLine && lineNo <= selectionEndLine;
    const prefix = inSelection ? ">>" : "  ";
    parts.push(`${String(lineNo).padStart(6, " ")}|${prefix} ${lineText}`);
  }
  return parts.join("\n");
}

/**
 * Build a sliding context window around the selection or caret.
 *
 * Line numbers in the output are absolute (1-based) so editor tools can
 * target the correct lines in the full buffer.
 *
 * @param {string} text Full document text.
 * @param {number} selStart UTF-16 selection start (inclusive).
 * @param {number} selEnd UTF-16 selection end (exclusive).
 * @param {{ linesBefore?: number, linesAfter?: number, maxFullDocLines?: number }} [opts]
 * @returns {{
 *   total_lines: number,
 *   window_start_line: number,
 *   window_end_line: number,
 *   selection_start_line: number,
 *   selection_end_line: number,
 *   has_selection: boolean,
 *   selected_text: string,
 *   numbered: string,
 *   is_truncated: boolean,
 * }}
 */
export function buildContextWindow(text, selStart, selEnd, opts = {}) {
  const doc = typeof text === "string" ? text : "";
  const lines = splitLines(doc);
  const totalLines = lines.length;
  const linesBefore = opts.linesBefore ?? DEFAULT_LINES_BEFORE;
  const linesAfter = opts.linesAfter ?? DEFAULT_LINES_AFTER;
  const maxFullDocLines = opts.maxFullDocLines ?? MAX_FULL_DOC_LINES;

  const { startLine, endLine, hasSelection, selectedText } = selectionLineRange(
    doc,
    selStart,
    selEnd
  );

  if (totalLines <= maxFullDocLines) {
    const numbered = formatNumberedWindow(
      lines,
      1,
      totalLines,
      startLine,
      endLine,
      hasSelection
    );
    return {
      total_lines: totalLines,
      window_start_line: 1,
      window_end_line: totalLines,
      selection_start_line: startLine,
      selection_end_line: endLine,
      has_selection: hasSelection,
      selected_text: selectedText,
      numbered,
      is_truncated: false,
    };
  }

  const windowStartLine = Math.max(1, startLine - linesBefore);
  const windowEndLine = Math.min(totalLines, endLine + linesAfter);
  const numbered = formatNumberedWindow(
    lines,
    windowStartLine,
    windowEndLine,
    startLine,
    endLine,
    hasSelection
  );

  return {
    total_lines: totalLines,
    window_start_line: windowStartLine,
    window_end_line: windowEndLine,
    selection_start_line: startLine,
    selection_end_line: endLine,
    has_selection: hasSelection,
    selected_text: selectedText,
    numbered,
    is_truncated: windowStartLine > 1 || windowEndLine < totalLines,
  };
}

/**
 * Refresh a previously computed window against the current buffer text.
 *
 * @param {string} text
 * @param {{ window_start_line: number, window_end_line: number, selection_start_line: number, selection_end_line: number, has_selection: boolean, total_lines: number, is_truncated: boolean }} anchor
 * @returns {ReturnType<typeof buildContextWindow>}
 */
export function refreshContextWindow(text, anchor) {
  const doc = typeof text === "string" ? text : "";
  const lines = splitLines(doc);
  const totalLines = lines.length;
  const windowStartLine = Math.min(Math.max(1, anchor.window_start_line), totalLines);
  const windowEndLine = Math.min(Math.max(windowStartLine, anchor.window_end_line), totalLines);
  const selectionStartLine = Math.min(
    Math.max(1, anchor.selection_start_line),
    totalLines
  );
  const selectionEndLine = Math.min(
    Math.max(selectionStartLine, anchor.selection_end_line),
    totalLines
  );

  return {
    total_lines: totalLines,
    window_start_line: windowStartLine,
    window_end_line: windowEndLine,
    selection_start_line: selectionStartLine,
    selection_end_line: selectionEndLine,
    has_selection: anchor.has_selection,
    selected_text: anchor.selected_text ?? "",
    numbered: formatNumberedWindow(
      lines,
      windowStartLine,
      windowEndLine,
      selectionStartLine,
      selectionEndLine,
      anchor.has_selection
    ),
    is_truncated:
      anchor.is_truncated || windowStartLine > 1 || windowEndLine < totalLines,
  };
}

/**
 * @param {string} userMessage
 * @param {ReturnType<typeof buildContextWindow>} window
 * @param {string|null} [path]
 * @returns {string}
 */
export function formatAgentUserMessage(userMessage, window, path = null) {
  const header = [];
  header.push(`Document: ${path && path.length > 0 ? path : "(untitled)"}`);
  header.push(`Total lines: ${window.total_lines}`);

  if (window.is_truncated) {
    header.push(
      `Context window: lines ${window.window_start_line}-${window.window_end_line} around ${window.has_selection ? "selection" : "caret"}. Line numbers below are absolute in the full document.`
    );
  } else {
    header.push("Full document shown below. Line numbers are 1-based.");
  }

  if (window.has_selection) {
    header.push(
      `Selection: lines ${window.selection_start_line}-${window.selection_end_line}`
    );
  } else {
    header.push(`Caret: line ${window.selection_start_line}`);
  }

  return `${header.join("\n")}\n\n${window.numbered}\n\nUser request: ${userMessage}`;
}

export const _internal = {
  formatNumberedWindow,
};
