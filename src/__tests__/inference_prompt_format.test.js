// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, expect, it } from "vitest";
import {
  _internal,
  parsePromptFileContents,
  serializePromptFileContents,
} from "../inference_panel.js";

describe("inference prompt file format", () => {
  it("clears structured_output when structured output is disabled", () => {
    const settings = _internal.normalizePromptFileSettings({
      structured_output_enabled: false,
      structured_output: '{"type":"object"}',
    });
    expect(settings.structured_output).toBe("");
  });

  it("keeps structured_output when enabled", () => {
    const schema = '{"type":"object","properties":{}}';
    const settings = _internal.normalizePromptFileSettings({
      structured_output_enabled: true,
      structured_output: schema,
    });
    expect(settings.structured_output).toBe(schema);
  });

  it("round-trips panel values through serialize and parse", () => {
    const values = {
      system_prompt: "Hello.",
      temperature: 0.3,
      seed: 42,
      limit_response_length: false,
      max_tokens: 512,
      context_overflow_policy: "rolling_window",
      stop_strings: "END",
      top_k: 20,
      repeat_penalty_enabled: false,
      repeat_penalty: 1,
      presence_penalty_enabled: true,
      presence_penalty: 0.5,
      top_p_enabled: false,
      top_p: 1,
      min_p_enabled: false,
      min_p: 0,
      structured_output_enabled: false,
      structured_output: "ignored",
      reasoning_enabled: false,
    };
    const parsed = parsePromptFileContents(serializePromptFileContents(values));
    expect(parsed.format).toBe("json");
    expect(parsed.settings).toMatchObject({
      system_prompt: "Hello.",
      temperature: 0.3,
      seed: 42,
      limit_response_length: false,
      max_tokens: 512,
      context_overflow_policy: "rolling_window",
      stop_strings: "END",
      structured_output_enabled: false,
      structured_output: "",
      reasoning_enabled: false,
    });
  });
});
