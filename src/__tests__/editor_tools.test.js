// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, it, expect } from "vitest";
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
} from "../editor_tools.js";

describe("editor_tools.splitLines", () => {
  it("returns a single empty line for empty input", () => {
    expect(splitLines("")).toEqual([""]);
  });

  it("splits on newlines", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("editor_tools.getDocumentSnapshot", () => {
  it("numbers lines from 1", () => {
    const snap = getDocumentSnapshot("alpha\nbeta");
    expect(snap.lines).toBe(2);
    expect(snap.numbered).toBe("1| alpha\n2| beta");
  });
});

describe("editor_tools.gotoLine", () => {
  it("clamps to valid range", () => {
    expect(gotoLine("only", 99)).toEqual({
      line: 1,
      column: 1,
      line_text: "only",
    });
  });
});

describe("editor_tools.insertText", () => {
  it("inserts at column within a line", () => {
    const result = insertText("hello", 1, 6, " world");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("hello world");
      expect(result.column).toBe(12);
    }
  });
});

describe("editor_tools.replaceLine", () => {
  it("replaces a single line", () => {
    const result = replaceLine("one\ntwo\nthree", 2, "TWO");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("one\nTWO\nthree");
      expect(result.line).toBe(2);
      expect(result.end_line).toBe(2);
    }
  });

  it("expands one line into multiple lines when text contains newlines", () => {
    const result = replaceLine("a\nb\nc", 2, "x\ny\nz");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("a\nx\ny\nz\nc");
      expect(result.end_line).toBe(4);
    }
  });
});

describe("editor_tools.replaceSpan", () => {
  it("replaces an inclusive column span within a line", () => {
    const line = '"items1":["car", "bike", "motorcycle", "van", "train"],';
    const result = replaceSpan(line, 1, 27, 36, "apple");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('"items1":["car", "bike", "apple", "van", "train"],');
    }
  });
});

describe("editor_tools.replaceRange", () => {
  it("replaces inclusive line range (legacy multi-line)", () => {
    const result = replaceRange("one\ntwo\nthree", 2, 2, "TWO");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("one\nTWO\nthree");
      expect(result.start_line).toBe(2);
      expect(result.end_line).toBe(2);
    }
  });

  it("swaps reversed ranges", () => {
    const result = replaceRange("a\nb\nc", 3, 1, "X");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("X");
    }
  });
});

describe("editor_tools.deleteLines", () => {
  it("deletes inclusive lines", () => {
    const result = deleteLines("a\nb\nc", 1, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("c");
      expect(result.deleted_lines).toBe(2);
      expect(result.start_line).toBe(1);
      expect(result.end_line).toBe(2);
    }
  });
});

describe("editor_tools.deleteSpan", () => {
  it("deletes an inclusive column span within a line", () => {
    const line = '"items1":["car", "bike", "motorcycle", "van", "train"],';
    const result = deleteSpan(line, 1, 27, 36);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('"items1":["car", "bike", "", "van", "train"],');
    }
  });
});

describe("editor_tools.deleteRange", () => {
  it("delegates to deleteLines (legacy alias)", () => {
    const result = deleteRange("a\nb\nc", 2, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("a\nc");
      expect(result.deleted_lines).toBe(1);
    }
  });
});

describe("editor_tools.executeTool", () => {
  it("returns numbered document via get_document", () => {
    const result = executeTool("get_document", {}, { text: "x\ny" });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("1| x\n2| y");
  });

  it("mutates via replace_line", () => {
    const result = executeTool(
      "replace_line",
      { line: 1, text: "done" },
      { text: "todo" }
    );
    expect(result.new_text).toBe("done");
  });

  it("mutates via replace_span", () => {
    const result = executeTool(
      "replace_span",
      { line: 1, start_column: 2, end_column: 4, text: "ip" },
      { text: "hello" }
    );
    expect(result.new_text).toBe("hipo");
  });

  it("mutates via delete_lines", () => {
    const result = executeTool(
      "delete_lines",
      { start_line: 2, end_line: 2 },
      { text: "a\nb\nc" }
    );
    expect(result.new_text).toBe("a\nc");
  });

  it("mutates via delete_span", () => {
    const result = executeTool(
      "delete_span",
      { line: 1, start_column: 2, end_column: 4 },
      { text: "hello" }
    );
    expect(result.new_text).toBe("ho");
  });

  it("maps legacy delete_range to delete_lines", () => {
    const result = executeTool(
      "delete_range",
      { start_line: 2, end_line: 2 },
      { text: "a\nb\nc" }
    );
    expect(result.new_text).toBe("a\nc");
  });

  it("maps legacy replace_range single-line calls to replace_line", () => {
    const result = executeTool(
      "replace_range",
      { start_line: 1, end_line: 1, text: "done" },
      { text: "todo" }
    );
    expect(result.new_text).toBe("done");
    expect(result.line).toBe(1);
  });
});

describe("editor_tools.joinLines", () => {
  it("joins with newline", () => {
    expect(joinLines(["a", "b"])).toBe("a\nb");
  });
});
