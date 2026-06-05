// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAgent, _internal } from "../agent.js";
import { buildContextWindow } from "../context_window.js";
import * as api from "../api.js";
import { loadDefaultToolsFixture } from "./setup/default_lmtools_fixture.js";

vi.mock("../api.js", () => ({
  agentTurn: vi.fn(),
}));

beforeEach(() => {
  loadDefaultToolsFixture();
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
            name: "replace_line",
            arguments: JSON.stringify({
              line: 1,
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
    expect(onToolCall.mock.calls[0][1]).toEqual(
      expect.objectContaining({ numbered: expect.any(String), lines: 1 })
    );
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
      { role: "user", content: "remove item A" },
      { role: "assistant", content: "Removed item A." },
      { role: "user", content: "put item A back" },
    ]);
  });

  it("uses live buffer text in the context window when the passed anchor is stale", async () => {
    const staleAnchor = buildContextWindow("old text", 0, 8);
    const bufferEl = document.createElement("textarea");
    bufferEl.value = "new text";

    vi.mocked(api.agentTurn).mockImplementation(async (messages) => {
      const userMessage = messages.find(
        (message) =>
          message.role === "user" &&
          String(message.content).includes("User request: fix it")
      );
      expect(String(userMessage?.content)).toContain("new text");
      expect(String(userMessage?.content)).not.toContain("old text");
      return {
        content: "ok",
        tool_calls: [],
        finish_reason: "stop",
      };
    });

    await runAgent({
      userMessage: "fix it",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: staleAnchor,
      callbacks: {
        getDocumentContext: () => ({
          text: bufferEl.value,
          path: null,
          contextAnchor: buildContextWindow(bufferEl.value, 0, bufferEl.value.length),
        }),
      },
    });
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

  it("emits agent context and assistant tool-turn content to callbacks", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: "I'll inspect the document first.",
        tool_calls: [
          {
            id: "call_1",
            name: "get_document",
            arguments: "{}",
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Done.",
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "Done.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "hello";
    const onAgentContext = vi.fn();
    const onAssistantToolTurn = vi.fn();

    await runAgent({
      userMessage: "read doc",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onAgentContext,
        onAssistantToolTurn,
      },
    });

    expect(onAgentContext).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: "read doc",
        systemPrompt: "",
      })
    );
    expect(onAssistantToolTurn).toHaveBeenCalledWith("I'll inspect the document first.");
  });
});

describe("agent _internal.buildSystemPrompt", () => {
  it("returns only the custom system prompt", () => {
    const prompt = _internal.buildSystemPrompt({ system_prompt: "Be concise." });
    expect(prompt).toBe("Be concise.");
  });
});
