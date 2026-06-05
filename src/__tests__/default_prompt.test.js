// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePromptFileContents } from "../inference_panel.js";

const defaultPromptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../default.prompt"
);

describe("default.prompt", () => {
  it("is valid JSON with all inference panel fields", () => {
    const raw = readFileSync(defaultPromptPath, "utf8");
    const parsed = parsePromptFileContents(raw);
    expect(parsed.format).toBe("json");

    const settings = parsed.settings;
    expect(settings.format_version).toBeUndefined();
    expect(settings.system_prompt).toContain("LLIMEdit");
    expect(settings.system_prompt).toContain("get_document");
    expect(settings.system_prompt).toContain("replace_line");
    expect(settings.system_prompt).toContain("insert_text");
    expect(settings.system_prompt).toContain("delete_lines");
    expect(settings.temperature).toBe(0.2);
    expect(settings.seed).toBe(0);
    expect(settings.limit_response_length).toBe(true);
    expect(settings.max_tokens).toBe(2048);
    expect(settings.context_overflow_policy).toBe("truncate_middle");
    expect(settings.stop_strings).toBe("");
    expect(settings.top_k).toBe(40);
    expect(settings.repeat_penalty_enabled).toBe(true);
    expect(settings.repeat_penalty).toBe(1.1);
    expect(settings.presence_penalty_enabled).toBe(false);
    expect(settings.presence_penalty).toBe(0);
    expect(settings.top_p_enabled).toBe(true);
    expect(settings.top_p).toBe(0.95);
    expect(settings.min_p_enabled).toBe(true);
    expect(settings.min_p).toBe(0.05);
    expect(settings.structured_output_enabled).toBe(false);
    expect(settings.structured_output).toBe("");
    expect(settings.reasoning_enabled).toBe(true);
  });

  it("declares format_version 1 in the file", () => {
    const data = JSON.parse(readFileSync(defaultPromptPath, "utf8"));
    expect(data.format_version).toBe(1);
  });
});
