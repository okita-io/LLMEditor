// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, it, expect } from "vitest";
import * as editorTools from "../editor_tools.js";
import {
  splitLines,
  resolveSpanColumns,
  lineColumnToIndex,
  applyLineColumnSpan,
  applyMutatingResult,
  applyGotoLine,
  applyToolSideEffects,
} from "../editor_tools.js";

describe("editor_tools.splitLines", () => {
  it("returns a single empty line for empty input", () => {
    expect(splitLines("")).toEqual([""]);
  });

  it("splits on newlines", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });
});

describe("editor_tools.resolveSpanColumns", () => {
  it("extends end column past end-of-line to the line end", () => {
    const span = resolveSpanColumns("car", 1, 5);
    expect(span.startIdx).toBe(0);
    expect(span.endIdx).toBe(3);
    expect(span.end_column).toBe(5);
    expect(span.effective_end_column).toBe(3);
  });

  it("swaps reversed columns", () => {
    const span = resolveSpanColumns("hello", 4, 2);
    expect(span.start_column).toBe(2);
    expect(span.end_column).toBe(4);
  });
});

describe("editor_tools.lineColumnToIndex", () => {
  it("maps columns past end-of-line to the line end", () => {
    expect(lineColumnToIndex("abc", 1, 99)).toBe(3);
  });

  it("accounts for preceding lines when computing the offset", () => {
    expect(lineColumnToIndex("ab\ncd", 2, 2)).toBe(4);
  });
});

describe("editor_tools.applyLineColumnSpan", () => {
  it("selects through end-of-line when end column is past the line", () => {
    const el = document.createElement("textarea");
    el.value = "car";
    applyLineColumnSpan(el, 1, 1, 5);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(3);
  });
});

describe("editor_tools.applyMutatingResult", () => {
  it("writes new_text into the buffer for an ok result", () => {
    const el = document.createElement("textarea");
    el.value = "todo";
    const changed = applyMutatingResult(el, { ok: true, new_text: "done" });
    expect(changed).toBe(true);
    expect(el.value).toBe("done");
  });

  it("leaves the buffer unchanged for a non-ok result", () => {
    const el = document.createElement("textarea");
    el.value = "todo";
    const changed = applyMutatingResult(el, { ok: false, new_text: "done" });
    expect(changed).toBe(false);
    expect(el.value).toBe("todo");
  });
});

describe("editor_tools.applyGotoLine", () => {
  it("places a collapsed caret at the start of the target line", () => {
    const el = document.createElement("textarea");
    el.value = "one\ntwo\nthree";
    applyGotoLine(el, { ok: true, line: 2 });
    expect(el.selectionStart).toBe(4);
    expect(el.selectionEnd).toBe(4);
  });
});

describe("editor_tools.applyToolSideEffects", () => {
  it("routes goto_line to caret placement", () => {
    const el = document.createElement("textarea");
    el.value = "one\ntwo";
    applyToolSideEffects(el, "goto_line", { ok: true, line: 2 });
    expect(el.selectionStart).toBe(4);
    expect(el.selectionEnd).toBe(4);
  });

  it("routes mutating tools to buffer mutation", () => {
    const el = document.createElement("textarea");
    el.value = "todo";
    applyToolSideEffects(el, "replace_line", { ok: true, new_text: "done" });
    expect(el.value).toBe("done");
  });
});

// Req 2.2: the Editor_Tools_Module defines no per-tool logic. Every pure tool
// function and the `executeTool` dispatcher were extracted into the
// `implementation` field of `default.lmtools`, so they must no longer be
// exported from the harness.
describe("editor_tools removed tool logic exports", () => {
  it("no longer exports the executeTool dispatcher", () => {
    expect(editorTools.executeTool).toBeUndefined();
  });

  it("no longer exports the per-tool pure functions", () => {
    expect(editorTools.getDocumentSnapshot).toBeUndefined();
    expect(editorTools.gotoLine).toBeUndefined();
    expect(editorTools.insertText).toBeUndefined();
    expect(editorTools.replaceLine).toBeUndefined();
    expect(editorTools.replaceSpan).toBeUndefined();
    expect(editorTools.deleteSpan).toBeUndefined();
    expect(editorTools.deleteLines).toBeUndefined();
    expect(editorTools.replaceRange).toBeUndefined();
    expect(editorTools.deleteRange).toBeUndefined();
  });

  it("no longer exports the joinLines helper", () => {
    expect(editorTools.joinLines).toBeUndefined();
  });
});
