// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Feature: extract-tools-to-lmtools, Property 6: agent-edit undo round-trip
//
// Property 6 — Validates: Requirements 7.4
//
// For any Document_Buffer and any mutating Tool_Result applied during an
// agent edit, a single undo operation restores the buffer to its exact
// content immediately before the result was applied.
//
// Harness: mirrors src/__tests__/editor_agent_undo.test.js and
// chat_apply_edits.test.js. The public path `applyDocumentEdits([edit])`
// (async) wraps `_beginAgentEdit`/`_applyAgentToolResult`/`_completeAgentEdit`
// and pushes a single "agent" Edit_Group onto the undo stack; `editor.undo()`
// reverts it. The default tools fixture is loaded so `executeAgentTool` runs
// the real extracted implementation from default.lmtools.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import * as editor from "../../editor.js";
import { loadDefaultToolsFixture } from "../setup/default_lmtools_fixture.js";

/** Install a fresh jsdom buffer and bind the editor to it. */
function installBuffer(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  editor.initialize();
  return el;
}

/** Number of 1-based lines in a buffer (matches splitLines semantics). */
function lineCount(text) {
  return text.length === 0 ? 1 : text.split("\n").length;
}

// A single line of buffer content. fc.string() draws from printable ASCII
// (0x20-0x7e), so it never contains a newline.
const lineArb = fc.string({ maxLength: 20 });

// A multi-line Document_Buffer (1..8 lines joined with "\n").
const bufferArb = fc
  .array(lineArb, { minLength: 1, maxLength: 8 })
  .map((lines) => lines.join("\n"));

// A buffer paired with a mutating Document_Tool edit whose line args are
// in range for that buffer (so the edit genuinely changes the buffer).
const scenarioArb = bufferArb.chain((text) => {
  const ln = fc.integer({ min: 1, max: lineCount(text) });

  const replaceLine = fc.record({
    name: fc.constant("replace_line"),
    args: fc.record({ line: ln, text: lineArb }),
  });

  const insertText = fc.record({
    name: fc.constant("insert_text"),
    args: fc.record({
      line: ln,
      column: fc.integer({ min: 1, max: 30 }),
      // Non-empty insertion so the edit actually mutates the buffer.
      text: fc.string({ minLength: 1, maxLength: 10 }),
    }),
  });

  const deleteLines = fc.record({
    name: fc.constant("delete_lines"),
    args: fc.record({ start_line: ln, end_line: ln }),
  });

  return fc.record({
    text: fc.constant(text),
    edit: fc.oneof(replaceLine, insertText, deleteLines),
  });
});

beforeEach(() => {
  loadDefaultToolsFixture();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Property 6: agent-edit undo round-trip", () => {
  it("a single undo restores the buffer to its exact pre-apply content", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ text, edit }) => {
        const el = installBuffer(text);
        const before = el.value;

        const applied = await editor.applyDocumentEdits([edit]);

        if (el.value !== before) {
          // The edit mutated the buffer (changed === true). A single undo
          // MUST restore the buffer to its exact pre-apply content (Req 7.4).
          expect(applied).toBeGreaterThan(0);
          editor.undo();
          expect(el.value).toBe(before);
        } else {
          // No-op edit: the buffer is unchanged and no agent Edit_Group was
          // committed, so undo is harmless and leaves the buffer correct.
          expect(applied).toBe(0);
          editor.undo();
          expect(el.value).toBe(before);
        }
      }),
      { numRuns: 100 }
    );
  });
});
