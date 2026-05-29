// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — editor_tools.js edge case and stability tests.
//
// After the tool-extraction refactor, all per-tool logic (the pure tool
// functions and the `executeTool` dispatcher) lives in the `implementation`
// field of `default.lmtools` and runs through the Tool_Runtime
// (`executeAgentTool` in `src/tool_editor.js`). This harness file now retains
// only side-effect application glue and the text-geometry utilities those side
// effects reach. These edge-case tests cover only that retained surface:
//   - splitLines boundary conditions
//   - applyMutatingResult buffer mutation
//   - applyGotoLine caret placement
//   - applyToolSideEffects routing

import { describe, expect, it } from "vitest";
import {
  splitLines,
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
