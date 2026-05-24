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

  it("nudges once when assistant describes edits without calling tools", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content:
          '```json\n{"tool":"insert_text","line":2,"column":1,"text":"added"}\n```',
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content:
          '```json\n{"tool":"insert_text","line":2,"column":1,"text":"added"}\n```',
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "Applied the insert.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "line1\nline2";
    const onUnappliedEditsHint = vi.fn();

    await runAgent({
      userMessage: "add text",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onUnappliedEditsHint,
      },
    });

    expect(api.agentTurn).toHaveBeenCalledTimes(3);
    // The apply nudge message should be in the conversation
    expect(api.agentTurn.mock.calls[2][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: expect.stringContaining("did not apply") }),
      ])
    );
  });

  it("includes prior chat turns before the latest user message", async () => {
    /** @type {Array<Array<Record<string, unknown>>>} */
    const capturedMessages = [];
    vi.mocked(api.agentTurn).mockImplementation(async (messages) => {
      capturedMessages.push(messages.map((message) => ({ ...message })));
      return {
        content: "Restored item A.",
        tool_calls: [],
        finish_reason: "stop",
      };
    });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "doc";

    await runAgent({
      userMessage: "put item A back",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      priorTurns: [
        { role: "user", content: "remove item A" },
        { role: "assistant", content: "Removed item A." },
      ],
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
      },
    });

    expect(capturedMessages[0]).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "remove item A" },
      { role: "assistant", content: "Removed item A." },
      { role: "user", content: "put item A back" },
    ]);
  });

  it("fires onUnappliedEditsHint when edits remain in final assistant text", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content:
          'Still in chat only:\n```json\n{"tool":"insert_text","line":1,"column":1,"text":"x"}\n```',
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content:
          'Still in chat only:\n```json\n{"tool":"insert_text","line":1,"column":1,"text":"x"}\n```',
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content:
          'Still in chat only:\n```json\n{"tool":"insert_text","line":1,"column":1,"text":"x"}\n```',
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "doc";
    const onUnappliedEditsHint = vi.fn();

    await runAgent({
      userMessage: "edit",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onUnappliedEditsHint,
      },
    });

    expect(onUnappliedEditsHint).toHaveBeenCalledTimes(1);
  });
});

describe("agent _internal.buildSystemPrompt", () => {
  it("appends default tool instructions to custom system prompt", () => {
    const prompt = _internal.buildSystemPrompt({ system_prompt: "Be concise." });
    expect(prompt).toContain("Be concise.");
    expect(prompt).toContain("context window");
  });
});
