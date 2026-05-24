// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAgent, _internal } from "../agent.js";
import * as api from "../api.js";

vi.mock("../api.js", () => ({
  agentTurn: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.agentTurn).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAgent", () => {
  it("executes tool calls and loops until assistant text", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_1",
            name: "replace_range",
            arguments: JSON.stringify({
              start_line: 1,
              end_line: 1,
              text: "updated",
            }),
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Line 1 updated.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "original";
    const onToolCall = vi.fn();
    const onAssistantMessage = vi.fn();

    const result = await runAgent({
      userMessage: "fix line 1",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onToolCall,
        onAssistantMessage,
      },
    });

    expect(result).toBe("Line 1 updated.");
    expect(bufferEl.value).toBe("updated");
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onAssistantMessage).toHaveBeenCalledWith("Line 1 updated.");
    expect(api.agentTurn).toHaveBeenCalledTimes(2);
  });
});

describe("agent _internal.buildSystemPrompt", () => {
  it("appends default tool instructions to custom system prompt", () => {
    const prompt = _internal.buildSystemPrompt({ system_prompt: "Be concise." });
    expect(prompt).toContain("Be concise.");
    expect(prompt).toContain("context window");
  });
});
