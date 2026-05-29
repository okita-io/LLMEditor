// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Feature: extract-tools-to-lmtools, Property 4: goto_line caret placement
//
// Property 4 — Validates Requirement 7.2.
//
// For any Document_Buffer and any goto_line Tool_Result with ok === true,
// applying the result places the caret at column 1 (the first character) of
// the reported 1-based line with no text selected
// (selectionStart === selectionEnd). The expected caret index is computed
// with the retained geometry helper lineColumnToIndex(buffer, line, 1).

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { applyGotoLine, lineColumnToIndex } from "../../editor_tools.js";

/**
 * A single buffer line fragment with any embedded newline/carriage return
 * stripped, so the generated line count stays deterministic.
 */
const lineFragmentArb = fc
  .string({ minLength: 0, maxLength: 24 })
  .map((s) => s.replace(/[\r\n]/g, ""));

/**
 * A multi-line buffer plus a reported 1-based line within 1..lineCount.
 * The reported line is derived from the buffer's line count because the
 * goto_line Tool_Result carries the already-clamped, already-reported line.
 */
const bufferAndLineArb = fc
  .array(lineFragmentArb, { minLength: 1, maxLength: 12 })
  .chain((lines) =>
    fc.record({
      buffer: fc.constant(lines.join("\n")),
      line: fc.integer({ min: 1, max: lines.length }),
    }),
  );

describe("Property 4: goto_line caret placement", () => {
  it("places a collapsed caret at column 1 of the reported line", () => {
    fc.assert(
      fc.property(bufferAndLineArb, ({ buffer, line }) => {
        const el = document.createElement("textarea");
        el.value = buffer;
        // applyGotoLine focuses/selects the element, so it must be attached.
        document.body.appendChild(el);

        try {
          const applied = applyGotoLine(el, { ok: true, line });

          expect(applied).toBe(true);
          // No text selected: caret is collapsed.
          expect(el.selectionStart).toBe(el.selectionEnd);
          // Caret sits at column 1 (first character) of the reported line.
          expect(el.selectionStart).toBe(lineColumnToIndex(buffer, line, 1));
        } finally {
          el.remove();
        }
      }),
      { numRuns: 100 },
    );
  });
});
