// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const defaultPromptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../default.prompt"
);

describe("default.prompt", () => {
  it("is a non-empty plain-text starter system prompt", () => {
    const raw = readFileSync(defaultPromptPath, "utf8").trim();
    expect(raw.length).toBeGreaterThan(40);
    expect(raw).toContain("LLIMEdit");
    expect(raw).toContain("tool");
  });
});
