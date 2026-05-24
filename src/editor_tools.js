// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Line-based editor tools for the LLM agent loop.

import { refreshContextWindow } from "./context_window.js";

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
 * @param {import("./context_window.js").buildContextWindow extends (...args: infer _A) => infer R ? R : never|null} [contextAnchor]
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
 * @param {string} text
 * @param {number} startLine 1-based inclusive
 * @param {number} endLine 1-based inclusive
 * @param {string} replacement
 * @returns {{ ok: true, text: string, start_line: number, end_line: number } | { ok: false, error: string }}
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
 * @param {number} startLine 1-based inclusive
 * @param {number} endLine 1-based inclusive
 * @returns {{ ok: true, text: string, deleted_lines: number } | { ok: false, error: string }}
 */
export function deleteRange(text, startLine, endLine) {
  const lines = splitLines(text);
  let start = clampLine(startLine, lines.length);
  let end = clampLine(endLine, lines.length);
  if (start > end) [start, end] = [end, start];
  const deleted = end - start + 1;
  const updated = [...lines.slice(0, start - 1), ...lines.slice(end)];
  if (updated.length === 0) updated.push("");
  return { ok: true, text: joinLines(updated), deleted_lines: deleted };
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
    case "replace_range": {
      const result = replaceRange(
        text,
        Number(args.start_line ?? 1),
        Number(args.end_line ?? 1),
        String(args.text ?? "")
      );
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        start_line: result.start_line,
        end_line: result.end_line,
        new_text: result.text,
      });
    }
    case "delete_range": {
      const result = deleteRange(
        text,
        Number(args.start_line ?? 1),
        Number(args.end_line ?? 1)
      );
      if (!result.ok) return { ...result, changed: false };
      return withChanged({
        ok: true,
        deleted_lines: result.deleted_lines,
        new_text: result.text,
      });
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
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
  const lines = splitLines(bufferEl.value);
  const ln = clampLine(line, lines.length);
  let offset = 0;
  for (let i = 0; i < ln - 1; i += 1) {
    offset += lines[i].length + 1;
  }
  bufferEl.focus();
  bufferEl.setSelectionRange(offset, offset);
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
  joinLines,
  clampLine,
};
