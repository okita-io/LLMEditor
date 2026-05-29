// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Feature: extract-tools-to-lmtools, Property 5: span selection bounds
//
// Property 5 — Validates Requirement 7.3:
// For any Document_Buffer and any replace_span/delete_span Tool_Result with
// ok === true, applying the result selects the text on the reported line from
// the 1-based inclusive start_column through the 1-based inclusive end_column,
// extending the selection to end-of-line when end_column exceeds the line length.
//
// The harness calls the retained glue `applyLineColumnSpan(bufferEl, line,
// startColumn, endColumn)` for span results. We drive that glue against a jsdom
// textarea and derive the EXPECTED selectionStart/selectionEnd independently
// from `splitLines` + `resolveSpanColumns`:
//   expected start = offset(line) + resolveSpanColumns(...).startIdx
//   expected end   = offset(line) + resolveSpanColumns(...).endIdx

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  splitLines,
  resolveSpanColumns,
  applyLineColumnSpan,
} from "../../editor_tools.js";

// Independent re-derivation of the harness's line clamping (1..max(1, total)).
function clampLine(line, totalLines) {
  const max = Math.max(1, totalLines);
  const n = Number.isFinite(line) ? Math.trunc(line) : 1;
  return Math.min(Math.max(1, n), max);
}

// Character offset of the first column of a 1-based line, assuming "\n" joins.
function lineStartOffset(lines, ln) {
  let offset = 0;
  for (let i = 0; i < ln - 1; i += 1) {
    offset += lines[i].length + 1;
  }
  return offset;
}

// A single buffer line: arbitrary text with newline characters stripped so the
// line count and "\n"-join offsets are well defined.
const lineArb = fc.string().map((s) => s.replace(/[\r\n]/g, ""));

describe("Property 5: span selection bounds", () => {
  it("selects start_column..end_column on the reported line, extending to EOL past the line length", () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 8 }),
        fc.nat({ max: 1000 }),
        // start/end columns deliberately include out-of-range values:
        // <= 0 (clamped to 1) and well past end-of-line (extend to EOL).
        fc.integer({ min: -3, max: 60 }),
        fc.integer({ min: -3, max: 60 }),
        (genLines, linePick, startColumn, endColumn) => {
          const buffer = genLines.join("\n");

          const el = document.createElement("textarea");
          el.value = buffer;
          // Use the value as actually stored by jsdom so the oracle and the
          // glue both reason about identical text.
          const actual = el.value;
          const lines = splitLines(actual);
          const lineCount = lines.length;

          // A line within 1..lineCount (multi-line buffers exercised).
          const line = (linePick % lineCount) + 1;
          const ln = clampLine(line, lineCount);
          const lineText = lines[ln - 1] ?? "";

          const span = resolveSpanColumns(lineText, startColumn, endColumn);
          const offset = lineStartOffset(lines, ln);
          const expectedStart = offset + span.startIdx;
          const expectedEnd = offset + span.endIdx;

          // Model a replace_span / delete_span Tool_Result (ok === true) by
          // invoking the glue the harness uses for span results.
          const result = {
            ok: true,
            line,
            start_column: startColumn,
            end_column: endColumn,
          };
          const applied = applyLineColumnSpan(
            el,
            result.line,
            result.start_column,
            result.end_column,
          );

          expect(applied).toBe(true);
          expect(el.selectionStart).toBe(expectedStart);
          expect(el.selectionEnd).toBe(expectedEnd);

          // Explicit end-of-line extension: when the (normalized, possibly
          // swapped) end column exceeds the line length, the selection end is
          // pinned to the end of that line.
          if (span.end_column > lineText.length) {
            expect(el.selectionEnd).toBe(offset + lineText.length);
          }

          // Selection bounds always stay within the buffer.
          expect(el.selectionStart).toBeGreaterThanOrEqual(0);
          expect(el.selectionEnd).toBeLessThanOrEqual(actual.length);
          expect(el.selectionStart).toBeLessThanOrEqual(el.selectionEnd);
        },
      ),
      { numRuns: 100 },
    );
  });
});
