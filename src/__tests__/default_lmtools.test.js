// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgentToolSchemas, parseToolFileContents } from "../tool_editor.js";
import { defaultLmtoolsPath, loadDefaultToolsFixture } from "./setup/default_lmtools_fixture.js";

const EXPECTED_TOOL_NAMES = [
  "get_document",
  "goto_line",
  "insert_text",
  "replace_line",
  "replace_span",
  "delete_lines",
  "delete_span",
];

describe("default.lmtools", () => {
  beforeEach(() => {
    loadDefaultToolsFixture();
  });

  it("parses seven document tool schemas from the repo starter file", () => {
    const raw = readFileSync(defaultLmtoolsPath, "utf8");
    // Use parseToolFileContents so the test works with both the current
    // split-text format (v2) and any legacy JSON-envelope files.
    const { implementation, schema: schemaStr } = parseToolFileContents(raw);
    const schemas = JSON.parse(schemaStr);
    const schemaArray = Array.isArray(schemas) ? schemas : [schemas];
    expect(schemaArray).toHaveLength(7);
    const names = schemaArray.map((t) => t.function?.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
    expect(typeof implementation).toBe("string");
    // The implementation now defines the tool logic directly rather than
    // forwarding to the harness dispatcher.
    expect(implementation).toContain("function run");
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(implementation).toContain(`function ${expected}`);
    }
    expect(implementation).not.toContain("editorTools.executeTool");
  });

  it("loads into the tool editor for agent requests", () => {
    const schemas = getAgentToolSchemas();
    expect(schemas).toHaveLength(7);
    const names = schemas.map((t) => t.function?.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });
});
