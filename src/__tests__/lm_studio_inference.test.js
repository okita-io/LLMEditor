// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, expect, it } from "vitest";
import {
  applyInferenceSettings,
  buildLmStudioChatBody,
  buildResponseFormat,
  contextOverflowPolicyApiValue,
  defaultLmStudioSettings,
  parseStopStrings,
} from "../lm_studio_inference.js";

describe("contextOverflowPolicyApiValue", () => {
  it("maps stored snake_case policies to LM Studio enum strings", () => {
    expect(contextOverflowPolicyApiValue("truncate_middle")).toBe("truncateMiddle");
    expect(contextOverflowPolicyApiValue("rolling_window")).toBe("rollingWindow");
    expect(contextOverflowPolicyApiValue("stop_at_limit")).toBe("stopAtLimit");
  });
});

describe("parseStopStrings", () => {
  it("splits on commas and newlines", () => {
    expect(parseStopStrings("END,\nSTOP")).toEqual(["END", "STOP"]);
    expect(parseStopStrings("  only  ")).toEqual(["only"]);
  });
});

describe("buildResponseFormat", () => {
  it("wraps bare JSON schema objects", () => {
    const fmt = buildResponseFormat('{"type":"object","properties":{"x":{"type":"string"}}}');
    expect(fmt?.type).toBe("json_schema");
    expect(fmt?.json_schema?.name).toBe("structured_output");
  });
});

describe("applyInferenceSettings", () => {
  it("omits lmstudio extension because LM Studio HTTP rejects it today", () => {
    const body = { model: "m", messages: [], temperature: 0.2, stream: false };
    applyInferenceSettings(body, defaultLmStudioSettings());
    expect(body.lmstudio).toBeUndefined();
  });

  it("includes OpenAI-compat sampling fields when enabled", () => {
    const body = {};
    applyInferenceSettings(
      body,
      defaultLmStudioSettings({
        stop_strings: "END",
        top_k: 40,
        repeat_penalty: 1.2,
        top_p: 0.9,
        min_p: 0.04,
      })
    );
    expect(body.stop).toEqual(["END"]);
    expect(body.top_k).toBe(40);
    expect(body.repeat_penalty).toBe(1.2);
    expect(body.top_p).toBe(0.9);
    expect(body.min_p).toBe(0.04);
  });

  it("omits max_tokens when limit_response_length is false", () => {
    const body = {};
    applyInferenceSettings(body, defaultLmStudioSettings({ limit_response_length: false }));
    expect(body.max_tokens).toBeUndefined();
  });

  it("omits reasoning_effort when reasoning_enabled is true (model default)", () => {
    const body = {};
    applyInferenceSettings(body, defaultLmStudioSettings({ reasoning_enabled: true }));
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("sends reasoning_effort: minimal when reasoning_enabled is false", () => {
    const body = {};
    applyInferenceSettings(body, defaultLmStudioSettings({ reasoning_enabled: false }));
    expect(body.reasoning_effort).toBe("minimal");
  });
});

describe("buildLmStudioChatBody", () => {
  it("builds agent-turn bodies with tools", () => {
    const messages = [{ role: "user", content: "hi" }];
    const body = buildLmStudioChatBody(defaultLmStudioSettings({ model: "test-model" }), messages, {
      stream: false,
      tools: [{ type: "function", function: { name: "get_document" } }],
    });
    expect(body.model).toBe("test-model");
    expect(body.messages).toBe(messages);
    expect(body.tools).toHaveLength(1);
    expect(body.lmstudio).toBeUndefined();
  });
});
