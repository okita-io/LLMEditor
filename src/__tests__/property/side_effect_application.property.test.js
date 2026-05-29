// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Feature: extract-tools-to-lmtools, Property 3: Side-effect application correctness
//
// Property 3 — Validates: Requirements 6.2, 6.3, 7.1, 7.5, 7.6, 8.3
//
// For any Tool_Result and Document_Buffer: if the result has ok === true,
// changed === true, and a string new_text, applying it sets the buffer
// content character-for-character equal to new_text; if the result's
// changed flag is not true (or ok is not true, or new_text is absent /
// non-string), applying it leaves the buffer content unchanged.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  applyMutatingResult,
  applyToolSideEffects,
} from "../../editor_tools.js";

/**
 * Mirror the real application decision used by the agent loop and the
 * chat-apply path: the buffer is only mutated when the Tool_Result is
 * `ok` AND `changed`. The actual DOM write is performed by the retained
 * glue (`applyMutatingResult`), which additionally requires a string
 * `new_text`. This is the gated "Side_Effect_Application" step that
 * Property 3 ranges over (cf. editor.js: `result.ok === true &&
 * result.changed === true`).
 *
 * @param {HTMLTextAreaElement} bufferEl
 * @param {Record<string, unknown>} result
 * @param {(el: HTMLTextAreaElement, r: Record<string, unknown>) => boolean} glue
 */
function applyResultGated(bufferEl, result, glue) {
  if (result && result.ok === true && result.changed === true) {
    glue(bufferEl, result);
  }
}

// Generate Tool_Result objects: vary `ok` and `changed` (booleans), and
// vary `new_text` so it is sometimes a string, sometimes a number,
// sometimes null, and sometimes absent entirely.
const resultArb = fc
  .record({
    ok: fc.boolean(),
    changed: fc.boolean(),
  })
  .chain((base) =>
    fc.oneof(
      fc.string().map((s) => ({ ...base, new_text: s })),
      fc.integer().map((n) => ({ ...base, new_text: n })),
      fc.constant({ ...base, new_text: null }),
      fc.constant({ ...base }), // new_text absent
    ),
  );

// Document_Buffer is an arbitrary string.
const bufferArb = fc.string();

describe("Property 3: Side-effect application correctness", () => {
  it("sets the buffer to new_text only when ok && changed && string new_text; otherwise unchanged (applyMutatingResult)", () => {
    fc.assert(
      fc.property(resultArb, bufferArb, (result, buffer) => {
        const textarea = document.createElement("textarea");
        textarea.value = buffer;

        applyResultGated(textarea, result, applyMutatingResult);

        const shouldMutate =
          result.ok === true &&
          result.changed === true &&
          typeof result.new_text === "string";

        if (shouldMutate) {
          expect(textarea.value).toBe(result.new_text);
        } else {
          expect(textarea.value).toBe(buffer);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("holds the same invariant when applied through applyToolSideEffects with a non-goto tool name", () => {
    fc.assert(
      fc.property(resultArb, bufferArb, (result, buffer) => {
        const textarea = document.createElement("textarea");
        textarea.value = buffer;

        // A non-"goto_line" name routes applyToolSideEffects to the
        // mutating-result glue path.
        applyResultGated(textarea, result, (el, r) =>
          applyToolSideEffects(el, "replace_line", r),
        );

        const shouldMutate =
          result.ok === true &&
          result.changed === true &&
          typeof result.new_text === "string";

        if (shouldMutate) {
          expect(textarea.value).toBe(result.new_text);
        } else {
          expect(textarea.value).toBe(buffer);
        }
      }),
      { numRuns: 100 },
    );
  });
});
