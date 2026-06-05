// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePromptFileContents } from "../inference_panel.js";

const appendPromptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../append.prompt"
);

describe("append.prompt", () => {
  it("is valid JSON with inference panel fields and documents append", () => {
    const raw = readFileSync(appendPromptPath, "utf8");
    const parsed = parsePromptFileContents(raw);
    expect(parsed.format).toBe("json");

    const settings = parsed.settings;
    expect(settings.system_prompt).toContain("append");
    expect(settings.system_prompt).toContain("tool");
    expect(settings.temperature).toBe(0.2);
    expect(settings.reasoning_enabled).toBe(true);
  });
});
