// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, it, expect } from "vitest";
import {
  lineAtOffset,
  selectionLineRange,
  buildContextWindow,
  formatAgentUserMessage,
  MAX_FULL_DOC_LINES,
} from "../context_window.js";

describe("context_window.lineAtOffset", () => {
  it("returns 1 for offset 0", () => {
    expect(lineAtOffset("hello", 0)).toBe(1);
  });

  it("counts lines after newlines", () => {
    expect(lineAtOffset("a\nb\nc", 3)).toBe(2);
  });
});

describe("context_window.selectionLineRange", () => {
  it("treats collapsed caret as a single line", () => {
    const doc = "one\ntwo\nthree";
    expect(selectionLineRange(doc, 4, 4)).toEqual({
      startLine: 2,
      endLine: 2,
      hasSelection: false,
      selectedText: "",
    });
  });

  it("captures multi-line selection", () => {
    const doc = "one\ntwo\nthree";
    expect(selectionLineRange(doc, 4, 7)).toEqual({
      startLine: 2,
      endLine: 2,
      hasSelection: true,
      selectedText: "two",
    });
  });
});

describe("context_window.buildContextWindow", () => {
  it("returns the full document for small files", () => {
    const doc = "alpha\nbeta";
    const window = buildContextWindow(doc, 6, 9);
    expect(window.is_truncated).toBe(false);
    expect(window.window_start_line).toBe(1);
    expect(window.window_end_line).toBe(2);
    expect(window.numbered).toContain(">> beta");
  });

  it("slides around a selection in a large file", () => {
    const lines = Array.from({ length: MAX_FULL_DOC_LINES + 20 }, (_, i) => `line ${i + 1}`);
    const doc = lines.join("\n");
    const selStart = doc.indexOf("line 80");
    const selEnd = selStart + "line 80".length;
    const window = buildContextWindow(doc, selStart, selEnd, {
      linesBefore: 10,
      linesAfter: 10,
    });

    expect(window.is_truncated).toBe(true);
    expect(window.window_start_line).toBe(70);
    expect(window.window_end_line).toBe(90);
    expect(window.selection_start_line).toBe(80);
    expect(window.numbered).toContain(">> line 80");
    expect(window.numbered).not.toContain("line 1|");
  });

  it("centers on caret when there is no selection", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `row ${i + 1}`);
    const doc = lines.join("\n");
    const caret = doc.indexOf("row 100");
    const window = buildContextWindow(doc, caret, caret, {
      linesBefore: 5,
      linesAfter: 5,
    });

    expect(window.has_selection).toBe(false);
    expect(window.selection_start_line).toBe(100);
    expect(window.window_start_line).toBe(95);
    expect(window.window_end_line).toBe(105);
  });
});

describe("context_window.formatAgentUserMessage", () => {
  it("includes window metadata and the user request", () => {
    const doc = "one\ntwo\nthree";
    const window = buildContextWindow(doc, 4, 7);
    const message = formatAgentUserMessage("fix grammar", window, "/tmp/x.txt");
    expect(message).toContain("Document: /tmp/x.txt");
    expect(message).toContain("Selection: lines 2-2");
    expect(message).toContain("User request: fix grammar");
    expect(message).toContain(">> two");
  });
});
