// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — editor_tools.js edge case and stability tests.
//
// Covers:
//   - Boundary conditions for line/column clamping
//   - Empty document handling
//   - Unicode content in tool operations
//   - Large document performance
//   - Invalid argument handling
//   - applyToolSideEffects integration
//   - getDocumentSnapshot with context anchors

import { describe, expect, it } from "vitest";
import {
  splitLines,
  joinLines,
  getDocumentSnapshot,
  gotoLine,
  insertText,
  replaceLine,
  replaceSpan,
  replaceRange,
  deleteLines,
  deleteSpan,
  deleteRange,
  executeTool,
  applyMutatingResult,
  applyGotoLine,
  applyToolSideEffects,
} from "../editor_tools.js";

describe("splitLines edge cases", () => {
  it("handles null/undefined gracefully", () => {
    expect(splitLines(null)).toEqual([""]);
    expect(splitLines(undefined)).toEqual([""]);
  });

  it("handles a single newline", () => {
    expect(splitLines("\n")).toEqual(["", ""]);
  });

  it("handles multiple consecutive newlines", () => {
    expect(splitLines("\n\n\n")).toEqual(["", "", "", ""]);
  });

  it("preserves trailing empty line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b", ""]);
  });
});

describe("gotoLine edge cases", () => {
  it("clamps line 0 to line 1", () => {
    expect(gotoLine("a\nb", 0)).toEqual({ line: 1, column: 1, line_text: "a" });
  });

  it("clamps negative line to line 1", () => {
    expect(gotoLine("a\nb", -5)).toEqual({ line: 1, column: 1, line_text: "a" });
  });

  it("clamps line beyond document to last line", () => {
    expect(gotoLine("a\nb", 999)).toEqual({ line: 2, column: 1, line_text: "b" });
  });

  it("handles empty document", () => {
    expect(gotoLine("", 1)).toEqual({ line: 1, column: 1, line_text: "" });
  });

  it("handles NaN line", () => {
    expect(gotoLine("a\nb", NaN)).toEqual({ line: 1, column: 1, line_text: "a" });
  });

  it("handles Infinity line (clamps via isFinite check to line 1)", () => {
    // Infinity is not finite, so clampLine treats it like NaN → line 1
    expect(gotoLine("a\nb", Infinity)).toEqual({ line: 1, column: 1, line_text: "a" });
  });
});

describe("insertText edge cases", () => {
  it("inserts at column 1 of an empty line", () => {
    const result = insertText("a\n\nc", 2, 1, "inserted");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\ninserted\nc");
  });

  it("clamps column beyond line length to end of line", () => {
    const result = insertText("short", 1, 999, "!");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("short!");
  });

  it("handles column 0 as column 1", () => {
    const result = insertText("abc", 1, 0, "X");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("Xabc");
  });

  it("handles empty insert text", () => {
    const result = insertText("abc", 1, 2, "");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("abc");
  });

  it("handles multi-line insert text", () => {
    const result = insertText("abc", 1, 4, "\nnew_line");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("abc\nnew_line");
  });

  it("handles unicode characters in insert", () => {
    const result = insertText("hello", 1, 6, " 🌍");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hello 🌍");
  });

  it("inserts into a document with unicode content", () => {
    // Column 4 means after the 3rd character of "日本語" → "日本語" + "テスト"
    // insertText uses string slice (UTF-16 index), so col 4 = index 3
    const result = insertText("café\n日本語", 2, 4, "テスト");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("日本語テスト");
  });
});

describe("replaceLine edge cases", () => {
  it("replaces the only line in a single-line document", () => {
    const result = replaceLine("only", 1, "replaced");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("replaced");
  });

  it("handles empty replacement (effectively a delete)", () => {
    const result = replaceLine("a\nb\nc", 2, "");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\n\nc");
  });

  it("handles replacement with multiple newlines", () => {
    const result = replaceLine("a\nb\nc", 2, "x\ny\nz");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\nx\ny\nz\nc");
  });
});

describe("replaceSpan edge cases", () => {
  it("replaces an inclusive column span", () => {
    const result = replaceSpan("hello", 1, 2, 4, "ip");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hipo");
  });

  it("swaps reversed column ranges", () => {
    const result = replaceSpan("abcdef", 1, 5, 2, "X");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("aXf");
  });

  it("clamps columns beyond line length", () => {
    const result = replaceSpan("short", 1, 3, 999, "!");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("sh!");
  });
});

describe("replaceRange edge cases", () => {
  it("replaces the only line in a single-line document", () => {
    const result = replaceRange("only", 1, 1, "replaced");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("replaced");
  });

  it("handles empty replacement (effectively a delete)", () => {
    const result = replaceRange("a\nb\nc", 2, 2, "");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\n\nc");
  });

  it("handles replacement with multiple newlines", () => {
    const result = replaceRange("a\nb\nc", 2, 2, "x\ny\nz");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\nx\ny\nz\nc");
  });

  it("clamps out-of-range start_line", () => {
    const result = replaceRange("a\nb", 0, 1, "X");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("X\nb");
  });

  it("clamps out-of-range end_line", () => {
    const result = replaceRange("a\nb", 2, 999, "X");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\nX");
  });

  it("handles reversed range (start > end)", () => {
    const result = replaceRange("a\nb\nc", 3, 1, "X");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("X");
  });

  it("replaces all lines", () => {
    const result = replaceRange("a\nb\nc", 1, 3, "single");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("single");
  });
});

describe("deleteLines edge cases", () => {
  it("deleting all lines leaves a single empty line", () => {
    const result = deleteLines("a\nb\nc", 1, 3);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("");
    expect(result.deleted_lines).toBe(3);
  });

  it("handles reversed range", () => {
    const result = deleteLines("a\nb\nc", 3, 1);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("");
    expect(result.deleted_lines).toBe(3);
  });

  it("clamps to valid range on single-line doc", () => {
    const result = deleteLines("only", 1, 999);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("");
    expect(result.deleted_lines).toBe(1);
  });

  it("deletes a single line from the middle", () => {
    const result = deleteLines("a\nb\nc\nd\ne", 3, 3);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\nb\nd\ne");
    expect(result.deleted_lines).toBe(1);
  });
});

describe("deleteSpan edge cases", () => {
  it("deletes an inclusive column span", () => {
    const result = deleteSpan("hello", 1, 2, 4);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("ho");
  });

  it("swaps reversed column ranges", () => {
    const result = deleteSpan("abcdef", 1, 5, 2);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("af");
  });
});

describe("deleteRange edge cases", () => {
  it("delegates to deleteLines (legacy alias)", () => {
    const result = deleteRange("a\nb\nc", 1, 2);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("c");
    expect(result.deleted_lines).toBe(2);
  });
});

describe("executeTool — unknown tool", () => {
  it("returns an error for unknown tool names", () => {
    const result = executeTool("nonexistent_tool", {}, { text: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown tool");
  });
});

describe("executeTool — get_document", () => {
  it("returns numbered content for empty document", () => {
    const result = executeTool("get_document", {}, { text: "" });
    expect(result.ok).toBe(true);
    expect(result.lines).toBe(1);
    expect(result.content).toBe("1| ");
  });

  it("includes path when provided", () => {
    const result = executeTool("get_document", {}, { text: "x", path: "/tmp/a.txt" });
    expect(result.path).toBe("/tmp/a.txt");
  });

  it("returns null path when not provided", () => {
    const result = executeTool("get_document", {}, { text: "x" });
    expect(result.path).toBeNull();
  });
});

describe("executeTool — changed detection", () => {
  it("reports changed: true when text differs", () => {
    const result = executeTool(
      "replace_line",
      { line: 1, text: "new" },
      { text: "old" }
    );
    expect(result.changed).toBe(true);
  });

  it("reports changed: false when text is identical", () => {
    const result = executeTool(
      "replace_line",
      { line: 1, text: "same" },
      { text: "same" }
    );
    expect(result.changed).toBe(false);
  });

  it("supports legacy replace_range for single-line edits", () => {
    const result = executeTool(
      "replace_range",
      { start_line: 1, end_line: 1, text: "new" },
      { text: "old" }
    );
    expect(result.changed).toBe(true);
    expect(result.new_text).toBe("new");
  });

  it("reports changed: false for goto_line (non-mutating)", () => {
    const result = executeTool("goto_line", { line: 1 }, { text: "abc" });
    expect(result.ok).toBe(true);
    // goto_line doesn't have a changed field since it's non-mutating
    expect(result.line_text).toBe("abc");
  });
});

describe("applyMutatingResult", () => {
  it("updates textarea value and dispatches input event", () => {
    const el = document.createElement("textarea");
    el.value = "old";
    let inputFired = false;
    el.addEventListener("input", () => { inputFired = true; });

    const applied = applyMutatingResult(el, { ok: true, new_text: "new" });

    expect(applied).toBe(true);
    expect(el.value).toBe("new");
    expect(inputFired).toBe(true);
  });

  it("returns false for failed results", () => {
    const el = document.createElement("textarea");
    el.value = "old";
    expect(applyMutatingResult(el, { ok: false, error: "fail" })).toBe(false);
    expect(el.value).toBe("old");
  });

  it("returns false for null element", () => {
    expect(applyMutatingResult(null, { ok: true, new_text: "x" })).toBe(false);
  });

  it("returns false when new_text is missing", () => {
    const el = document.createElement("textarea");
    expect(applyMutatingResult(el, { ok: true })).toBe(false);
  });
});

describe("applyGotoLine", () => {
  it("sets selection to the start of the target line", () => {
    const el = document.createElement("textarea");
    el.value = "line1\nline2\nline3";
    document.body.appendChild(el);

    const applied = applyGotoLine(el, { ok: true, line: 2 });

    expect(applied).toBe(true);
    expect(el.selectionStart).toBe(6); // after "line1\n"
    expect(el.selectionEnd).toBe(6);
    el.remove();
  });

  it("returns false for invalid result", () => {
    const el = document.createElement("textarea");
    expect(applyGotoLine(el, { ok: false })).toBe(false);
    expect(applyGotoLine(el, null)).toBe(false);
    expect(applyGotoLine(null, { ok: true, line: 1 })).toBe(false);
  });
});

describe("applyToolSideEffects", () => {
  it("routes goto_line to applyGotoLine", () => {
    const el = document.createElement("textarea");
    el.value = "a\nb";
    document.body.appendChild(el);

    const applied = applyToolSideEffects(el, "goto_line", { ok: true, line: 2 });

    expect(applied).toBe(true);
    expect(el.selectionStart).toBe(2);
    el.remove();
  });

  it("routes mutating tools to applyMutatingResult", () => {
    const el = document.createElement("textarea");
    el.value = "old";

    const applied = applyToolSideEffects(el, "replace_range", {
      ok: true,
      new_text: "new",
    });

    expect(applied).toBe(true);
    expect(el.value).toBe("new");
  });
});

describe("large document performance", () => {
  it("handles a 10000-line document without error", () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`);
    const doc = lines.join("\n");

    const result = replaceRange(doc, 5000, 5000, "REPLACED");
    expect(result.ok).toBe(true);
    const resultLines = result.text.split("\n");
    expect(resultLines[4999]).toBe("REPLACED");
    expect(resultLines.length).toBe(10000);
  });

  it("getDocumentSnapshot numbers lines correctly for large docs", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `row ${i + 1}`);
    const doc = lines.join("\n");
    const snap = getDocumentSnapshot(doc);
    expect(snap.lines).toBe(200);
    expect(snap.numbered).toContain("200| row 200");
  });
});
