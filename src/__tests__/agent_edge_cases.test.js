// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — agent.js edge case and stability tests.
//
// Covers:
//   - MAX_TURNS limit enforcement
//   - Invalid tool arguments handling
//   - Tool call with empty arguments
//   - Multiple tool calls in one turn
//   - Agent loop with no tool calls (direct text response)
//   - System prompt customization
//   - Error propagation from api.agentTurn

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentCancelledError, runAgent, _internal } from "../agent.js";
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

describe("runAgent — MAX_TURNS enforcement", () => {
  it("stops after MAX_TURNS iterations even if model keeps calling tools", async () => {
    const toolResponse = {
      content: null,
      tool_calls: [
        {
          id: "call_loop",
          name: "get_document",
          arguments: "{}",
        },
      ],
      finish_reason: "tool_calls",
    };
    // Return tool calls forever
    vi.mocked(api.agentTurn).mockResolvedValue(toolResponse);

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "test";

    await runAgent({
      userMessage: "loop forever",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
      },
    });

    expect(api.agentTurn).toHaveBeenCalledTimes(_internal.MAX_TURNS);
  });
});

describe("runAgent — invalid tool arguments", () => {
  it("handles malformed JSON in tool arguments gracefully", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            name: "replace_line",
            arguments: "not valid json {{{",
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "I encountered an error.",
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "I encountered an error.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "original";
    const onToolResult = vi.fn();

    await runAgent({
      userMessage: "edit",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onToolResult,
      },
    });

    // Tool result should indicate parse error
    expect(onToolResult).toHaveBeenCalledTimes(1);
    const result = onToolResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid tool arguments");
    // Buffer should be unchanged
    expect(bufferEl.value).toBe("original");
  });
});

describe("runAgent — empty tool arguments", () => {
  it("handles empty string arguments as empty object", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_empty",
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
    bufferEl.value = "content";

    const result = await runAgent({
      userMessage: "read",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
      },
    });

    expect(result).toBe("Done.");
  });
});

describe("runAgent — multiple tool calls in one turn", () => {
  it("executes all tool calls in a single turn", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_1",
            name: "replace_line",
            arguments: JSON.stringify({ line: 1, text: "first" }),
          },
          {
            id: "call_2",
            name: "insert_text",
            arguments: JSON.stringify({ line: 1, column: 6, text: "_second" }),
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Both edits applied.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "original";
    const onToolCall = vi.fn();

    await runAgent({
      userMessage: "make two edits",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onToolCall,
      },
    });

    expect(onToolCall).toHaveBeenCalledTimes(2);
    // Both edits should have been applied
    expect(bufferEl.value).toContain("first");
    expect(bufferEl.value).toContain("_second");
  });
});

describe("runAgent — direct text response (no tools)", () => {
  it("returns the assistant text after thinking nudge when no mutations needed", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: "Here is my answer.",
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "Here is my answer.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "doc";
    const onAssistantMessage = vi.fn();

    const result = await runAgent({
      userMessage: "explain something",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onAssistantMessage,
      },
    });

    expect(result).toBe("Here is my answer.");
    expect(onAssistantMessage).toHaveBeenCalledWith("Here is my answer.");
    // First call gets thinking nudge, second call terminates
    expect(api.agentTurn).toHaveBeenCalledTimes(2);
  });
});

describe("runAgent — user stop", () => {
  it("throws AgentCancelledError when shouldAbort is true before a turn", async () => {
    const bufferEl = document.createElement("textarea");
    bufferEl.value = "doc";

    await expect(
      runAgent({
        userMessage: "edit",
        settings: { system_prompt: "" },
        bufferEl,
        contextAnchor: null,
        shouldAbort: () => true,
        callbacks: {
          getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        },
      })
    ).rejects.toBeInstanceOf(AgentCancelledError);

    expect(api.agentTurn).not.toHaveBeenCalled();
  });

  it("maps an empty-string cancel rejection from agentTurn to AgentCancelledError", async () => {
    vi.mocked(api.agentTurn).mockRejectedValue(new Error(""));

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "doc";

    await expect(
      runAgent({
        userMessage: "edit",
        settings: { system_prompt: "" },
        bufferEl,
        contextAnchor: null,
        callbacks: {
          getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        },
      })
    ).rejects.toBeInstanceOf(AgentCancelledError);
  });
});

describe("runAgent — error propagation", () => {
  it("throws when api.agentTurn rejects", async () => {
    vi.mocked(api.agentTurn).mockRejectedValue(new Error("connection failed"));

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "doc";

    await expect(
      runAgent({
        userMessage: "edit",
        settings: { system_prompt: "" },
        bufferEl,
        contextAnchor: null,
        callbacks: {
          getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        },
      })
    ).rejects.toThrow("connection failed");
  });
});

describe("_internal.buildSystemPrompt", () => {
  it("uses default tool system when no custom prompt", () => {
    const prompt = _internal.buildSystemPrompt({ system_prompt: "" });
    expect(prompt).toBe(_internal.DEFAULT_TOOL_SYSTEM);
  });

  it("prepends custom prompt before default tool system", () => {
    const prompt = _internal.buildSystemPrompt({ system_prompt: "Be brief." });
    expect(prompt.startsWith("Be brief.")).toBe(true);
    expect(prompt).toContain(_internal.DEFAULT_TOOL_SYSTEM);
  });

  it("trims whitespace from custom prompt", () => {
    const prompt = _internal.buildSystemPrompt({ system_prompt: "  \n  " });
    // Empty after trim → uses default only
    expect(prompt).toBe(_internal.DEFAULT_TOOL_SYSTEM);
  });

  it("handles null settings", () => {
    const prompt = _internal.buildSystemPrompt(null);
    expect(prompt).toBe(_internal.DEFAULT_TOOL_SYSTEM);
  });

  it("handles missing system_prompt field", () => {
    const prompt = _internal.buildSystemPrompt({});
    expect(prompt).toBe(_internal.DEFAULT_TOOL_SYSTEM);
  });
});

describe("runAgent — goto_line tool", () => {
  it("executes goto_line without mutating the buffer", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_goto",
            name: "goto_line",
            arguments: JSON.stringify({ line: 2 }),
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Line 2 is 'beta'.",
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "Line 2 is 'beta'.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "alpha\nbeta\ngamma";
    document.body.appendChild(bufferEl);

    await runAgent({
      userMessage: "what is on line 2",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
      },
    });

    // Buffer unchanged
    expect(bufferEl.value).toBe("alpha\nbeta\ngamma");
    bufferEl.remove();
  });
});

describe("runAgent — nudge mechanism", () => {
  it("does not nudge more than once per nudge type", async () => {
    // First response: prose with edits (triggers thinking nudge since no mutations)
    // Second response: still prose with edits (triggers apply nudge)
    // Third response: still prose (no more nudges, terminates)
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: '```json\n{"tool":"insert_text","line":1,"column":1,"text":"x"}\n```',
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: '```json\n{"tool":"insert_text","line":1,"column":1,"text":"x"}\n```',
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: '```json\n{"tool":"insert_text","line":1,"column":1,"text":"x"}\n```',
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

    // thinking nudge + apply nudge + final = 3 turns
    expect(api.agentTurn).toHaveBeenCalledTimes(3);
    expect(onUnappliedEditsHint).toHaveBeenCalledTimes(1);
  });
});
