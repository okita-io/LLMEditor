// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_NAMES,
  ensureDefaultToolsLoaded,
  getDefaultToolSchemas,
  isDefaultTool,
} from "../default_tools.js";

describe("default_tools", () => {
  it("loads seven built-in tool schemas from default.lmtools", async () => {
    await ensureDefaultToolsLoaded();
    const schemas = getDefaultToolSchemas();
    expect(schemas).toHaveLength(7);
    const names = schemas.map((t) => t.function?.name);
    for (const expected of DEFAULT_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it("recognizes default tool names", () => {
    expect(isDefaultTool("replace_line")).toBe(true);
    expect(isDefaultTool("my_tool")).toBe(false);
  });
});
