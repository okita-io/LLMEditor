// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESIGN_DOCUMENT_EDITOR_WIDTH_PX,
  DESIGN_TOOL_CONSOLE_HEIGHT_PX,
  DESIGN_TOOL_EDITOR_PANE_HEIGHT_PX,
  DESIGN_TOOL_FILE_BAR_HEIGHT_PX,
} from "../tool_layout.js";

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "../styles.css");

describe("tool_layout (LLIMEdit-design.pen)", () => {
  it("exports design dimensions from the pen file", () => {
    expect(DESIGN_DOCUMENT_EDITOR_WIDTH_PX).toBe(568);
    expect(DESIGN_TOOL_EDITOR_PANE_HEIGHT_PX).toBe(396);
    expect(DESIGN_TOOL_FILE_BAR_HEIGHT_PX).toBe(86);
    expect(DESIGN_TOOL_CONSOLE_HEIGHT_PX).toBe(76);
  });

  it("styles.css applies the tool editor pane default height", () => {
    const css = readFileSync(stylesPath, "utf8");
    expect(css).toMatch(/#tool-editor-pane\s*\{[^}]*height:\s*396px/);
    expect(css).toMatch(/grid-template-rows:\s*auto minmax\(0,\s*1fr\)\s*76px/);
    expect(css).toMatch(/#document-editor\s*\{[^}]*min-width:\s*568px/);
    expect(css).toMatch(/#tool-console[\s\S]*height:\s*76px/);
  });
});
