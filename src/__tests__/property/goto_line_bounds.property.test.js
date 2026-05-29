// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Property-based test for the extract-tools-to-lmtools feature.
//
// Feature: extract-tools-to-lmtools, Property 8: goto_line line bounds
//
// Property 8 — Validates: Requirements 8.5, 10.3
//
// For any Document_Buffer content and any goto_line arguments carrying an
// integer line value (including values below 1 or above the line count), the
// line number reported in the Tool_Result is within the inclusive range
// 1 to max(1, lineCount). `executeAgentTool` runs the extracted goto_line via
// the loaded default tools, clamping the requested line to that range.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("../../api.js", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  listModels: vi.fn(),
  listModelsDetailed: vi.fn(),
}));

import { _internal, executeAgentTool } from "../../tool_editor.js";
import { loadDefaultToolsFixture } from "../setup/default_lmtools_fixture.js";

// Same splitLines semantics as the extracted implementation:
//   "" -> 1 line; otherwise text.split("\n").length
function lineCountOf(text) {
  if (typeof text !== "string" || text.length === 0) return 1;
  return text.split("\n").length;
}

describe("Property 8: goto_line line bounds (Req 8.5, 10.3)", () => {
  beforeEach(() => {
    _internal.resetForTests();
    loadDefaultToolsFixture();
  });

  afterEach(() => {
    _internal.resetForTests();
    vi.clearAllMocks();
  });

  it("reports a line within 1..max(1, lineCount) for any integer line arg", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Arbitrary multi-line buffer strings (including the empty string).
        fc.array(fc.string(), { maxLength: 40 }).map((rows) => rows.join("\n")),
        // Line values that can be far below 1 or far above the line count.
        fc.integer({ min: -100, max: 100000 }),
        async (text, line) => {
          const result = await executeAgentTool(
            "goto_line",
            { line },
            { text, path: null }
          );

          const lineCount = lineCountOf(text);

          expect(result.ok).toBe(true);
          expect(result.line).toBeGreaterThanOrEqual(1);
          expect(result.line).toBeLessThanOrEqual(Math.max(1, lineCount));
        }
      ),
      { numRuns: 100 }
    );
  });
});
