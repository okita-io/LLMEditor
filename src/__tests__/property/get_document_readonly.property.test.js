// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Property-based test for the extract-tools-to-lmtools feature.
//
// Feature: extract-tools-to-lmtools, Property 7: get_document is read-only
//
// Property 7 — Validates: Requirements 8.4
//
// For any Document_Buffer content, executing `get_document` through the
// Tool_Runtime leaves the buffer content unchanged and returns a Tool_Result
// whose `changed` flag is false. `executeAgentTool` operates on `ctx.text`
// (a value, not a DOM element), so "buffer unchanged" means the runtime
// produces no `new_text` mutation: we assert `result.new_text` is undefined
// and `result.changed === false`.

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

describe("Property 7: get_document is read-only (Req 8.4)", () => {
  beforeEach(() => {
    _internal.resetForTests();
    loadDefaultToolsFixture();
  });

  afterEach(() => {
    _internal.resetForTests();
    vi.clearAllMocks();
  });

  it("leaves the buffer unchanged and returns changed:false for any buffer content", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Arbitrary multi-line buffer strings (including empty lines, blank
        // documents, unicode, and many lines).
        fc.array(fc.string(), { maxLength: 40 }).map((rows) => rows.join("\n")),
        async (text) => {
          const result = await executeAgentTool("get_document", {}, {
            text,
            path: null,
          });

          // (a) The runtime reports no change.
          expect(result.changed).toBe(false);

          // (b) The buffer is not mutated: get_document never emits new_text.
          expect(result.new_text).toBeUndefined();

          // get_document is a read-only success that returns string content.
          expect(result.ok).toBe(true);
          expect(typeof result.content).toBe("string");
        }
      ),
      { numRuns: 100 }
    );
  });
});
