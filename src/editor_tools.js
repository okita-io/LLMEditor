// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Harness glue for the LLM agent loop.
//
// This module retains ONLY the side-effect application helpers (buffer
// mutation, caret moves, span selection) and the tool-agnostic
// text-geometry utilities those side effects reach directly or
// transitively. All per-tool logic now lives in the `implementation`
// field of `default.lmtools` and is executed through the Tool_Runtime
// (`executeAgentTool` in `src/tool_editor.js`); this file computes no
// Tool_Result and no transformed buffer text.

/**
 * @param {string} value
 * @returns {string[]}
 */
export function splitLines(value) {
  if (typeof value !== "string") return [""];
  if (value.length === 0) return [""];
  return value.split("\n");
}

/**
 * @param {number} line
 * @param {number} totalLines
 * @returns {number}
 */
function clampLine(line, totalLines) {
  const max = Math.max(1, totalLines);
  const n = Number.isFinite(line) ? Math.trunc(line) : 1;
  return Math.min(Math.max(1, n), max);
}

/**
 * @param {number} column 1-based
 * @returns {number}
 */
function normalizeColumn(column) {
  const n = Number.isFinite(column) ? Math.trunc(column) : 1;
  return Math.max(1, n);
}

/**
 * Resolve a 1-based inclusive column span on a single line.
 * Columns beyond the line end behave like a text editor: they extend to end-of-line.
 *
 * @param {string} lineText
 * @param {number} startColumn 1-based inclusive
 * @param {number} endColumn 1-based inclusive
 * @returns {{
 *   start_column: number,
 *   end_column: number,
 *   effective_start_column: number,
 *   effective_end_column: number,
 *   startIdx: number,
 *   endIdx: number,
 * }}
 */
export function resolveSpanColumns(lineText, startColumn, endColumn) {
  const current = typeof lineText === "string" ? lineText : "";
  const length = current.length;
  let startCol = normalizeColumn(startColumn);
  let endCol = normalizeColumn(endColumn);
  if (startCol > endCol) [startCol, endCol] = [endCol, startCol];

  const startIdx = Math.min(startCol - 1, length);
  const endIdx = Math.min(endCol, length);
  const effectiveStartColumn = length === 0 ? 1 : Math.min(startCol, length + 1);
  const effectiveEndColumn = length === 0 ? 1 : Math.min(endCol, length);

  return {
    start_column: startCol,
    end_column: endCol,
    effective_start_column: effectiveStartColumn,
    effective_end_column: effectiveEndColumn,
    startIdx,
    endIdx,
  };
}

/**
 * @param {string} text
 * @param {number} line 1-based
 * @param {number} column 1-based; values past the line end map to end-of-line
 * @returns {number}
 */
export function lineColumnToIndex(text, line, column) {
  const lines = splitLines(typeof text === "string" ? text : "");
  const ln = clampLine(line, lines.length);
  let offset = 0;
  for (let i = 0; i < ln - 1; i += 1) {
    offset += lines[i].length + 1;
  }
  const lineText = lines[ln - 1] ?? "";
  const col = normalizeColumn(column);
  return offset + Math.min(col - 1, lineText.length);
}

/**
 * Apply a mutating tool result to a textarea element.
 *
 * @param {HTMLTextAreaElement} bufferEl
 * @param {Record<string, unknown>} result
 * @returns {boolean}
 */
export function applyMutatingResult(bufferEl, result) {
  if (!bufferEl || !result || result.ok !== true) return false;
  if (typeof result.new_text === "string") {
    bufferEl.value = result.new_text;
    bufferEl.dispatchEvent(new Event("input"));
    return true;
  }
  return false;
}

/**
 * Move the caret after goto_line.
 *
 * @param {HTMLTextAreaElement} bufferEl
 * @param {Record<string, unknown>} result
 * @returns {boolean}
 */
export function applyGotoLine(bufferEl, result) {
  if (!bufferEl || !result || result.ok !== true) return false;
  const line = Number(result.line);
  if (!Number.isFinite(line)) return false;
  bufferEl.focus();
  bufferEl.setSelectionRange(lineColumnToIndex(bufferEl.value, line, 1), lineColumnToIndex(bufferEl.value, line, 1));
  bufferEl.dispatchEvent(new Event("select"));
  return true;
}

/**
 * Select a 1-based column span on a line. Columns past end-of-line extend to the line end.
 *
 * @param {HTMLTextAreaElement} bufferEl
 * @param {number} line 1-based
 * @param {number} startColumn 1-based inclusive
 * @param {number} endColumn 1-based inclusive
 * @returns {boolean}
 */
export function applyLineColumnSpan(bufferEl, line, startColumn, endColumn) {
  if (!bufferEl) return false;
  const lines = splitLines(bufferEl.value);
  const ln = clampLine(line, lines.length);
  const span = resolveSpanColumns(lines[ln - 1] ?? "", startColumn, endColumn);
  let offset = 0;
  for (let i = 0; i < ln - 1; i += 1) {
    offset += lines[i].length + 1;
  }
  const start = offset + span.startIdx;
  const end = offset + span.endIdx;
  bufferEl.focus();
  bufferEl.setSelectionRange(start, end);
  bufferEl.dispatchEvent(new Event("select"));
  return true;
}

/**
 * Apply side effects for a tool result (buffer edits or caret moves).
 *
 * @param {HTMLTextAreaElement} bufferEl
 * @param {string} name
 * @param {Record<string, unknown>} result
 * @returns {boolean}
 */
export function applyToolSideEffects(bufferEl, name, result) {
  if (name === "goto_line") {
    return applyGotoLine(bufferEl, result);
  }
  return applyMutatingResult(bufferEl, result);
}

export const _internal = {
  splitLines,
  clampLine,
  resolveSpanColumns,
  normalizeColumn,
};
