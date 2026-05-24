// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, it, expect } from "vitest";
import {
  splitLines,
  joinLines,
  getDocumentSnapshot,
  gotoLine,
  insertText,
  replaceRange,
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

describe("editor_tools.replaceRange", () => {
  it("replaces inclusive line range", () => {
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

describe("editor_tools.deleteRange", () => {
  it("deletes inclusive lines", () => {
    const result = deleteRange("a\nb\nc", 1, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("c");
      expect(result.deleted_lines).toBe(2);
    }
  });
});

describe("editor_tools.executeTool", () => {
  it("returns numbered document via get_document", () => {
    const result = executeTool("get_document", {}, { text: "x\ny" });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("1| x\n2| y");
  });

  it("mutates via replace_range", () => {
    const result = executeTool(
      "replace_range",
      { start_line: 1, end_line: 1, text: "done" },
      { text: "todo" }
    );
    expect(result.new_text).toBe("done");
  });
});

describe("editor_tools.joinLines", () => {
  it("joins with newline", () => {
    expect(joinLines(["a", "b"])).toBe("a\nb");
  });
});
