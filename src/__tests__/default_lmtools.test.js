// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgentTools } from "../tool_editor.js";
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
    const parsed = JSON.parse(raw);
    const schemas = Array.isArray(parsed.schema) ? parsed.schema : [parsed.schema];
    expect(schemas).toHaveLength(7);
    const names = schemas.map((t) => t.function?.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
    expect(typeof parsed.implementation).toBe("string");
    expect(parsed.implementation).toContain("editorTools.executeTool");
  });

  it("loads into the tool editor for agent requests", () => {
    const schemas = getAgentTools();
    expect(schemas).toHaveLength(7);
    const names = schemas.map((t) => t.function?.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });
});
