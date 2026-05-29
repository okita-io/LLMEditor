// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// ============================================================================
// FROZEN REFERENCE ORACLE — DO NOT MODIFY
// ============================================================================
// This file is a verbatim, frozen copy of the pre-extraction tool logic that
// lived in `src/editor_tools.js` before the "extract-tools-to-lmtools" refactor.
//
// It exists solely so the model-based equivalence harness (Task 10.2) can
// compare the extracted Tool_Implementation's results against the original
// pre-extraction behavior. It MUST NEVER be modified: changing it would
// invalidate the equivalence guarantee (Requirement 8.2).
//
// This file is test-only and MUST NOT be imported by any production code.
//
// The ONLY change from the original `src/editor_tools.js` is the relative
// import path for `refreshContextWindow` (the oracle lives two levels deeper,
// under src/__tests__/oracles/), so `get_document` produces identical windowed
// content. All tool logic below is unchanged.
// ============================================================================

import { refreshContextWindow } from "../../context_window.js";

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
 * @param {string[]} lines
 * @returns {string}
 */
export function joinLines(lines) {
  return lines.join("\n");
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
 * @param {string} text
 * @param {string|null} [path]
 * @param {import("../../context_window.js").buildContextWindow extends (...args: infer _A) => infer R ? R : never|null} [contextAnchor]
 * @returns {{ lines: number, numbered: string, path: string|null, is_truncated: boolean, window_start_line: number, window_end_line: number }}
 */
export function getDocumentSnapshot(text, path = null, contextAnchor = null) {
  const lines = splitLines(typeof text === "string" ? text : "");
  const resolvedPath = typeof path === "string" && path.length > 0 ? path : null;

  if (contextAnchor && typeof contextAnchor === "object") {
    const window = refreshContextWindow(text, contextAnchor);
    return {
      lines: window.total_lines,
      numbered: window.numbered,
      path: resolvedPath,
      is_truncated: window.is_truncated,
      window_start_line: window.window_start_line,
      window_end_line: window.window_end_line,
    };
  }

  const numbered = lines.map((line, index) => `${index + 1}| ${line}`).join("\n");
  return {
    lines: lines.length,
    numbered,
    path: resolvedPath,
    is_truncated: false,
    window_start_line: 1,
    window_end_line: lines.length,
  };
}

/**
 * @param {string} text
 * @param {number} line 1-based
 * @returns {{ line: number, column: number, line_text: string }}
 */
export function gotoLine(text, line) {
  const lines = splitLines(text);
  const ln = clampLine(line, lines.length);
  const lineText = lines[ln - 1] ?? "";
  return { line: ln, column: 1, line_text: lineText };
}

/**
 * @param {string} text
 * @param {number} line 1-based
 * @param {number} column 1-based
 * @param {string} insertText
 * @returns {{ ok: true, text: string, line: number, column: number } | { ok: false, error: string }}
 */
export function insertText(text, line, column, insertText) {
  const lines = splitLines(text);
  const ln = clampLine(line, lines.length);
  const col = Number.isFinite(column) ? Math.max(1, Math.trunc(column)) : 1;
  const insert = typeof insertText === "string" ? insertText : "";
  const current = lines[ln - 1] ?? "";
  const index = Math.min(col - 1, current.length);
  lines[ln - 1] = current.slice(0, index) + insert + current.slice(index);
  return {
    ok: true,
    text: joinLines(lines),
    line: ln,
    column: index + insert.length + 1,
  };
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
 * @param {string} text
 * @param {number} line 1-based
 * @param {string} replacement
 * @returns {{ ok: true, text: string, line: number, end_line: number } | { ok: false, error: string }}
 */
export function replaceLine(text, line, replacement) {
  const lines = splitLines(text);
  const ln = clampLine(line, lines.length);
  const newLines = splitLines(typeof replacement === "string" ? replacement : "");
  const updated = [...lines.slice(0, ln - 1), ...newLines, ...lines.slice(ln)];
  return {
    ok: true,
    text: joinLines(updated),
    line: ln,
    end_line: ln + newLines.length - 1,
  };
}

/**
 * @param {string} text
 * @param {number} line 1-based
 * @param {number} startColumn 1-based inclusive
 * @param {number} endColumn 1-based inclusive
 * @param {string} replacement
 * @returns {{ ok: true, text: string, line: number, start_column: number, end_column: number } | { ok: false, error: string }}
 */
export function replaceSpan(text, line, startColumn, endColumn, replacement) {
  const lines = splitLines(text);
  const ln = clampLine(line, lines.length);
  const current = lines[ln - 1] ?? "";
  const span = resolveSpanColumns(current, startColumn, endColumn);
  const insert = typeof replacement === "string" ? replacement : "";
  lines[ln - 1] = current.slice(0, span.startIdx) + insert + current.slice(span.endIdx);
  return {
    ok: true,
    text: joinLines(lines),
    line: ln,
    start_column: span.start_column,
    end_column: span.end_column,
    effective_start_column: span.effective_start_column,
    effective_end_column: span.effective_end_column,
  };
}

/**
 * @param {string} text
 * @param {number} startLine 1-based inclusive
 * @param {number} endLine 1-based inclusive
 * @param {string} replacement
 * @returns {{ ok: true, text: string, start_line: number, end_line: number } | { ok: false, error: string }}
 * @deprecated Legacy helper; prefer replace_line or delete_lines + insert_text.
 */
export function replaceRange(text, startLine, endLine, replacement) {
  const lines = splitLines(text);
  let start = clampLine(startLine, lines.length);
  let end = clampLine(endLine, lines.length);
  if (start > end) [start, end] = [end, start];
  const newLines = splitLines(typeof replacement === "string" ? replacement : "");
  const updated = [...lines.slice(0, start - 1), ...newLines, ...lines.slice(end)];
  return {
    ok: true,
    text: joinLines(updated),
    start_line: start,
    end_line: start + newLines.length - 1,
  };
}

/**
 * @param {string} text
 * @param {number} line 1-based
 * @param {number} startColumn 1-based inclusive
 * @param {number} endColumn 1-based inclusive
 * @returns {{ ok: true, text: string, line: number, start_column: number, end_column: number } | { ok: false, error: string }}
 */
export function deleteSpan(text, line, startColumn, endColumn) {
  return replaceSpan(text, line, startColumn, endColumn, "");
}

/**
 * @param {string} text
 * @param {number} startLine 1-based inclusive
 * @param {number} endLine 1-based inclusive
 * @returns {{ ok: true, text: string, start_line: number, end_line: number, deleted_lines: number } | { ok: false, error: string }}
 */
export function deleteLines(text, startLine, endLine) {
  const lines = splitLines(text);
  let start = clampLine(startLine, lines.length);
  let end = clampLine(endLine, lines.length);
  if (start > end) [start, end] = [end, start];
  const deleted = end - start + 1;
  const updated = [...lines.slice(0, start - 1), ...lines.slice(end)];
  if (updated.length === 0) updated.push("");
  return {
    ok: true,
    text: joinLines(updated),
    start_line: start,
    end_line: end,
    deleted_lines: deleted,
  };
}

/**
 * @param {string} text
 * @param {number} startLine 1-based inclusive
 * @param {number} endLine 1-based inclusive
 * @returns {{ ok: true, text: string, deleted_lines: number } | { ok: false, error: string }}
 * @deprecated Legacy alias for deleteLines.
 */
export function deleteRange(text, startLine, endLine) {
  const result = deleteLines(text, startLine, endLine);
  if (!result.ok) return result;
  return { ok: true, text: result.text, deleted_lines: result.deleted_lines };
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ text: string, path?: string|null, contextAnchor?: object|null }} ctx
 * @returns {Record<string, unknown>}
 */
export function executeTool(name, args, ctx) {
  const text = typeof ctx.text === "string" ? ctx.text : "";
  const path = ctx.path ?? null;
  const contextAnchor = ctx.contextAnchor ?? null;

  /** @param {Record<string, unknown>} result */
  const withChanged = (result) => {
    if (!result || result.ok !== true || typeof result.new_text !== "string") {
      return { ...result, changed: false };
    }
    return { ...result, changed: result.new_text !== text };
  };

  switch (name) {
    case "get_document": {
      const snap = getDocumentSnapshot(text, path, contextAnchor);
      return {
        ok: true,
        lines: snap.lines,
        path: snap.path,
        content: snap.numbered,
        is_truncated: snap.is_truncated,
        window_start_line: snap.window_start_line,
        window_end_line: snap.window_end_line,
      };
    }
    case "goto_line": {
      const line = Number(args.line ?? args.start_line ?? 1);
      return { ok: true, ...gotoLine(text, line) };
    }
    case "insert_text": {
      const result = insertText(
        text,
        Number(args.line ?? 1),
        Number(args.column ?? 1),
        String(args.text ?? "")
      );
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        line: result.line,
        column: result.column,
        new_text: result.text,
      });
    }
    case "replace_line": {
      const result = replaceLine(text, Number(args.line ?? 1), String(args.text ?? ""));
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        line: result.line,
        end_line: result.end_line,
        new_text: result.text,
      });
    }
    case "replace_span": {
      const result = replaceSpan(
        text,
        Number(args.line ?? 1),
        Number(args.start_column ?? 1),
        Number(args.end_column ?? 1),
        String(args.text ?? "")
      );
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        line: result.line,
        start_column: result.start_column,
        end_column: result.end_column,
        effective_start_column: result.effective_start_column,
        effective_end_column: result.effective_end_column,
        new_text: result.text,
      });
    }
    case "replace_range": {
      const startLine = Number(args.start_line ?? 1);
      const endLine = Number(args.end_line ?? 1);
      const replacement = String(args.text ?? "");
      const result =
        startLine === endLine
          ? replaceLine(text, startLine, replacement)
          : replaceRange(text, startLine, endLine, replacement);
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        line: "line" in result ? result.line : result.start_line,
        start_line: "start_line" in result ? result.start_line : result.line,
        end_line: result.end_line,
        new_text: result.text,
      });
    }
    case "delete_lines": {
      const result = deleteLines(
        text,
        Number(args.start_line ?? 1),
        Number(args.end_line ?? 1)
      );
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        start_line: result.start_line,
        end_line: result.end_line,
        deleted_lines: result.deleted_lines,
        new_text: result.text,
      });
    }
    case "delete_span": {
      const result = deleteSpan(
        text,
        Number(args.line ?? 1),
        Number(args.start_column ?? 1),
        Number(args.end_column ?? 1)
      );
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        line: result.line,
        start_column: result.start_column,
        end_column: result.end_column,
        effective_start_column: result.effective_start_column,
        effective_end_column: result.effective_end_column,
        new_text: result.text,
      });
    }
    case "delete_range": {
      const result = deleteLines(
        text,
        Number(args.start_line ?? 1),
        Number(args.end_line ?? 1)
      );
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        start_line: result.start_line,
        end_line: result.end_line,
        deleted_lines: result.deleted_lines,
        new_text: result.text,
      });
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}
