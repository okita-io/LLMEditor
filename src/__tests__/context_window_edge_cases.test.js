// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — context_window.js edge case and stability tests.
//
// Covers:
//   - Empty document handling
//   - Single-line documents
//   - Selection at document boundaries
//   - refreshContextWindow with changed document
//   - formatAgentUserMessage variations
//   - Unicode content in context windows

import { describe, expect, it } from "vitest";
import {
  lineAtOffset,
  selectionLineRange,
  buildContextWindow,
  refreshContextWindow,
  formatAgentUserMessage,
  MAX_FULL_DOC_LINES,
  DEFAULT_LINES_BEFORE,
  DEFAULT_LINES_AFTER,
} from "../context_window.js";

describe("lineAtOffset edge cases", () => {
  it("returns 1 for empty string", () => {
    expect(lineAtOffset("", 0)).toBe(1);
  });

  it("returns 1 for negative offset", () => {
    expect(lineAtOffset("abc", -1)).toBe(1);
  });

  it("clamps offset beyond string length", () => {
    expect(lineAtOffset("a\nb", 999)).toBe(2);
  });

  it("handles offset exactly at newline", () => {
    expect(lineAtOffset("a\nb", 1)).toBe(1);
    expect(lineAtOffset("a\nb", 2)).toBe(2);
  });

  it("handles multiple consecutive newlines", () => {
    expect(lineAtOffset("a\n\n\nb", 3)).toBe(3);
    expect(lineAtOffset("a\n\n\nb", 4)).toBe(4);
  });
});

describe("selectionLineRange edge cases", () => {
  it("handles empty document", () => {
    const result = selectionLineRange("", 0, 0);
    expect(result).toEqual({
      startLine: 1,
      endLine: 1,
      hasSelection: false,
      selectedText: "",
    });
  });

  it("handles selection at very start", () => {
    const result = selectionLineRange("abc\ndef", 0, 3);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(1);
    expect(result.hasSelection).toBe(true);
    expect(result.selectedText).toBe("abc");
  });

  it("handles selection spanning entire document", () => {
    const doc = "a\nb\nc";
    const result = selectionLineRange(doc, 0, doc.length);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(3);
    expect(result.hasSelection).toBe(true);
    expect(result.selectedText).toBe(doc);
  });

  it("handles negative selStart", () => {
    const result = selectionLineRange("abc", -1, 2);
    expect(result.startLine).toBe(1);
    expect(result.hasSelection).toBe(true);
  });

  it("handles selEnd beyond document length", () => {
    const result = selectionLineRange("abc", 0, 999);
    expect(result.hasSelection).toBe(true);
  });
});

describe("buildContextWindow edge cases", () => {
  it("handles empty document", () => {
    const w = buildContextWindow("", 0, 0);
    expect(w.total_lines).toBe(1);
    expect(w.is_truncated).toBe(false);
    expect(w.numbered).toContain("1|");
  });

  it("handles single-line document", () => {
    const w = buildContextWindow("hello", 0, 5);
    expect(w.total_lines).toBe(1);
    expect(w.is_truncated).toBe(false);
    expect(w.has_selection).toBe(true);
    expect(w.selected_text).toBe("hello");
  });

  it("handles document at exactly MAX_FULL_DOC_LINES", () => {
    const lines = Array.from({ length: MAX_FULL_DOC_LINES }, (_, i) => `line ${i + 1}`);
    const doc = lines.join("\n");
    const w = buildContextWindow(doc, 0, 0);
    expect(w.is_truncated).toBe(false);
    expect(w.window_start_line).toBe(1);
    expect(w.window_end_line).toBe(MAX_FULL_DOC_LINES);
  });

  it("truncates at MAX_FULL_DOC_LINES + 1", () => {
    const lines = Array.from({ length: MAX_FULL_DOC_LINES + 1 }, (_, i) => `line ${i + 1}`);
    const doc = lines.join("\n");
    const caret = doc.indexOf(`line ${MAX_FULL_DOC_LINES}`);
    const w = buildContextWindow(doc, caret, caret);
    expect(w.is_truncated).toBe(true);
  });

  it("window clamps to document start when selection is near beginning", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const doc = lines.join("\n");
    const w = buildContextWindow(doc, 0, 0, { linesBefore: 50, linesAfter: 50 });
    expect(w.window_start_line).toBe(1);
  });

  it("window clamps to document end when selection is near end", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const doc = lines.join("\n");
    const caret = doc.length;
    const w = buildContextWindow(doc, caret, caret, { linesBefore: 50, linesAfter: 50 });
    expect(w.window_end_line).toBe(200);
  });

  it("marks selected lines with >> prefix", () => {
    const doc = "a\nb\nc\nd\ne";
    const selStart = doc.indexOf("b");
    const selEnd = doc.indexOf("d") + 1;
    const w = buildContextWindow(doc, selStart, selEnd);
    expect(w.numbered).toContain(">>"); // selected lines marked
    expect(w.numbered).toMatch(/2\|>> b/);
  });

  it("handles non-string text gracefully", () => {
    const w = buildContextWindow(null, 0, 0);
    expect(w.total_lines).toBe(1);
    expect(w.is_truncated).toBe(false);
  });

  it("respects custom linesBefore/linesAfter options", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const doc = lines.join("\n");
    const caret = doc.indexOf("line 100");
    const w = buildContextWindow(doc, caret, caret, {
      linesBefore: 5,
      linesAfter: 5,
    });
    expect(w.window_start_line).toBe(95);
    expect(w.window_end_line).toBe(105);
  });
});

describe("refreshContextWindow", () => {
  it("refreshes against a shorter document", () => {
    const anchor = {
      window_start_line: 10,
      window_end_line: 30,
      selection_start_line: 20,
      selection_end_line: 20,
      has_selection: false,
      total_lines: 50,
      is_truncated: true,
      selected_text: "",
    };
    const shortDoc = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = refreshContextWindow(shortDoc, anchor);
    expect(result.total_lines).toBe(15);
    expect(result.window_end_line).toBeLessThanOrEqual(15);
    expect(result.selection_start_line).toBeLessThanOrEqual(15);
  });

  it("refreshes against a longer document", () => {
    const anchor = {
      window_start_line: 5,
      window_end_line: 20,
      selection_start_line: 10,
      selection_end_line: 10,
      has_selection: false,
      total_lines: 20,
      is_truncated: false,
      selected_text: "",
    };
    const longDoc = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = refreshContextWindow(longDoc, anchor);
    expect(result.total_lines).toBe(100);
    expect(result.window_start_line).toBe(5);
    expect(result.window_end_line).toBe(20);
  });

  it("handles empty text", () => {
    const anchor = {
      window_start_line: 1,
      window_end_line: 5,
      selection_start_line: 3,
      selection_end_line: 3,
      has_selection: false,
      total_lines: 5,
      is_truncated: false,
      selected_text: "",
    };
    const result = refreshContextWindow("", anchor);
    expect(result.total_lines).toBe(1);
    expect(result.window_start_line).toBe(1);
    expect(result.window_end_line).toBe(1);
  });
});

describe("formatAgentUserMessage", () => {
  it("includes untitled when path is null", () => {
    const w = buildContextWindow("hello", 0, 0);
    const msg = formatAgentUserMessage("fix it", w, null);
    expect(msg).toContain("(untitled)");
    expect(msg).toContain("User request: fix it");
  });

  it("includes path when provided", () => {
    const w = buildContextWindow("hello", 0, 0);
    const msg = formatAgentUserMessage("fix it", w, "/tmp/test.txt");
    expect(msg).toContain("/tmp/test.txt");
  });

  it("includes total lines count", () => {
    const doc = "a\nb\nc";
    const w = buildContextWindow(doc, 0, 0);
    const msg = formatAgentUserMessage("edit", w);
    expect(msg).toContain("Total lines: 3");
  });

  it("includes selection info when selection exists", () => {
    const doc = "a\nb\nc";
    const w = buildContextWindow(doc, 2, 3); // select "b"
    const msg = formatAgentUserMessage("edit", w);
    expect(msg).toContain("Selection:");
  });

  it("includes caret info when no selection", () => {
    const doc = "a\nb\nc";
    const w = buildContextWindow(doc, 2, 2);
    const msg = formatAgentUserMessage("edit", w);
    expect(msg).toContain("Caret:");
  });

  it("mentions truncation for large documents", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const doc = lines.join("\n");
    const caret = doc.indexOf("line 100");
    const w = buildContextWindow(doc, caret, caret, { linesBefore: 10, linesAfter: 10 });
    const msg = formatAgentUserMessage("edit", w);
    expect(msg).toContain("Context window:");
  });
});

describe("unicode in context windows", () => {
  it("handles emoji in document text", () => {
    const doc = "hello 🌍\nworld 🎉\nend";
    const w = buildContextWindow(doc, 0, 0);
    expect(w.total_lines).toBe(3);
    expect(w.numbered).toContain("🌍");
    expect(w.numbered).toContain("🎉");
  });

  it("handles CJK characters", () => {
    const doc = "日本語\n中文\n한국어";
    const w = buildContextWindow(doc, 0, 0);
    expect(w.total_lines).toBe(3);
    expect(w.numbered).toContain("日本語");
  });
});
