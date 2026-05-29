// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Feature: extract-tools-to-lmtools, Property 2: Model-based equivalence with the pre-extraction oracle
//
// This is the headline validation of the refactor. It proves that the
// EXTRACTED runtime — `executeAgentTool` in src/tool_editor.js running the
// default.lmtools implementation — produces, for every document tool, a
// Tool_Result deep-equal to the one the FROZEN pre-extraction oracle
// (src/__tests__/oracles/editor_tools_reference.js) produced for the same
// buffer and arguments. See design.md → "Correctness Properties" → Property 2
// and the Tool_Result Data Models table.
//
// Property 2 — Validates Requirements 8.2, 1.4, 1.5, 2.1, 10.3.

import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";

import { executeAgentTool, _internal as toolEditorInternal } from "../../tool_editor.js";
import * as referenceModule from "../oracles/editor_tools_reference.js";
import { buildContextWindow, refreshContextWindow } from "../../context_window.js";
import { loadDefaultToolsFixture } from "../setup/default_lmtools_fixture.js";

// The seven schema tools PLUS the two legacy variants (replace_range,
// delete_range). The legacy variants are not advertised in the schema but
// remain runnable through the runtime registry (Req 1.2), so they are part of
// the equivalence guarantee.
const TOOL_NAMES = [
  "get_document",
  "goto_line",
  "insert_text",
  "replace_line",
  "replace_span",
  "delete_lines",
  "delete_span",
  "replace_range",
  "delete_range",
];

// A single line of buffer text with newline characters stripped, so the
// array's length deterministically controls the buffer's line count. This lets
// the line/column generators reliably produce values both inside and outside
// the buffer's range, exercising the clamp-to-bounds behavior (Req 10.3).
const lineText = fc.string({ maxLength: 16 }).map((s) => s.replace(/[\r\n]/g, ""));

// Multi-line buffer: an empty array yields "" (empty buffer), one element a
// single line, more elements multiple lines.
const bufferArb = fc.array(lineText, { maxLength: 12 }).map((lines) => lines.join("\n"));

// Replacement / insertion text. Allowed to contain newlines so multi-line
// expansion paths (e.g. replace_line, replace_range) are exercised.
const replacementArb = fc.string({ maxLength: 8 });

// One generic args record carrying every field any tool reads. Each tool picks
// only the fields it needs via `args.<field> ?? default`; extra fields are
// ignored identically by both the extracted impl and the oracle. Line/column
// integers intentionally span below 1 and above the buffer's line count to
// drive out-of-range clamping.
const ARG_INT = fc.integer({ min: -3, max: 25 });
const argsArb = fc.record({
  line: ARG_INT,
  column: ARG_INT,
  start_line: ARG_INT,
  end_line: ARG_INT,
  start_column: ARG_INT,
  end_column: ARG_INT,
  text: replacementArb,
});

// Optional path: a non-empty string or null. Both impls resolve a path to null
// when it is absent or empty, so this exercises get_document's `path` field.
const pathArb = fc.option(
  fc.string({ minLength: 1, maxLength: 12 }).map((s) => s.replace(/[\r\n]/g, "")),
  { nil: null }
);

// Optional selection offsets used to build a contextAnchor for get_document.
// `null` exercises the simple-numbering fallback; a tuple exercises the
// windowed path. The anchor is built with buildContextWindow so it has the
// exact shape refreshContextWindow expects.
const selectionArb = fc.option(fc.tuple(fc.nat(4000), fc.nat(4000)), { nil: null });

describe("extract-tools-to-lmtools — model-based equivalence (Property 2)", () => {
  beforeEach(() => {
    toolEditorInternal.resetForTests();
    // Load the extracted default.lmtools implementation + schema into the
    // runtime so executeAgentTool runs the extracted logic by name.
    loadDefaultToolsFixture();
  });

  it("extracted runtime matches the frozen oracle for every tool, buffer, and args (>=100 runs)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TOOL_NAMES),
        bufferArb,
        argsArb,
        pathArb,
        selectionArb,
        async (name, text, args, path, selection) => {
          // Build a context window anchor for get_document's windowed path.
          // For all other tools the anchor is unused.
          let contextAnchor = null;
          if (selection) {
            const start = Math.min(selection[0], selection[1]);
            const end = Math.max(selection[0], selection[1]);
            contextAnchor = buildContextWindow(text, start, end);
          }

          // Oracle ctx is exactly { text, path, contextAnchor } — the oracle
          // imports refreshContextWindow itself.
          const oracleCtx = { text, path, contextAnchor };
          // The extracted runtime's get_document needs refreshWindow injected
          // through ctx so it builds the identical window the oracle does.
          const runtimeCtx = {
            text,
            path,
            contextAnchor,
            refreshWindow: refreshContextWindow,
          };

          const expected = referenceModule.executeTool(name, args, oracleCtx);
          const actual = await executeAgentTool(name, args, runtimeCtx);

          if (name === "get_document") {
            // DOCUMENTED, INTENTIONAL DIFFERENCE (design.md Data Models):
            // the extracted get_document explicitly adds `changed: false` to
            // mark itself read-only, whereas the frozen oracle's get_document
            // case predates that and returns no `changed` field. This is the
            // ONLY allowed difference. We reconcile by augmenting the oracle
            // result with `changed: false` and then asserting full deep
            // equality of ok / content / metadata. Any other divergence
            // (lines, path, content, is_truncated, window bounds) still fails.
            expect(actual).toEqual({ ...expected, changed: false });
          } else {
            // Mutating tools and goto_line must be exactly deep-equal:
            // ok, changed, new_text, and every tool-specific metadata field.
            expect(actual).toEqual(expected);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
