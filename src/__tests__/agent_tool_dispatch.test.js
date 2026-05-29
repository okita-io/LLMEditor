// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — agent.js tool-dispatch integration/edge tests.
//
// Feature: extract-tools-to-lmtools — Requirement 6 (Agent Loop Behavior Preserved).
//
// Covers:
//   - Multiple tool calls applied in order, cumulative buffer (Req 6.1)
//   - Unknown-tool name leaves the buffer unchanged (Req 6.4)
//   - Malformed tool arguments leave the buffer unchanged (Req 6.5)
//   - onToolCall documentView is 1-based numbered current buffer (Req 6.6)
//
// The agent loop dispatches every tool call through the async Tool_Runtime
// (executeAgentTool), which runs the extracted implementation from
// default.lmtools loaded via loadDefaultToolsFixture().

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAgent } from "../agent.js";
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

describe("runAgent — multiple tool calls execute in order (Req 6.1)", () => {
  it("applies several tool calls in the returned order with a cumulative buffer", async () => {
    // Three insert_text calls that each append to end-of-line. Their suffixes
    // appear in call order only if the loop executes them sequentially and
    // re-reads the (cumulatively mutated) buffer before each call.
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_1",
            name: "insert_text",
            arguments: JSON.stringify({ line: 1, column: 100, text: "-1" }),
          },
          {
            id: "call_2",
            name: "insert_text",
            arguments: JSON.stringify({ line: 1, column: 100, text: "-2" }),
          },
          {
            id: "call_3",
            name: "insert_text",
            arguments: JSON.stringify({ line: 1, column: 100, text: "-3" }),
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Applied three inserts.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "X";
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    const result = await runAgent({
      userMessage: "append three suffixes",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onToolCall,
        onToolResult,
      },
    });

    expect(result).toBe("Applied three inserts.");
    // Cumulative result reflects the suffixes applied in call order.
    expect(bufferEl.value).toBe("X-1-2-3");
    expect(onToolCall).toHaveBeenCalledTimes(3);
    expect(onToolResult).toHaveBeenCalledTimes(3);
    // Each call mutated the buffer successfully.
    for (const call of onToolResult.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({ ok: true, changed: true })
      );
    }
    // Only a single model turn was needed for the tool calls.
    expect(api.agentTurn).toHaveBeenCalledTimes(2);
  });
});

describe("runAgent — unknown tool name (Req 6.4)", () => {
  it("returns an unknown-tool result and leaves the buffer unchanged", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_unknown",
            name: "frobnicate",
            arguments: JSON.stringify({ foo: "bar" }),
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "I could not do that.",
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "I could not do that.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "untouched";
    const onToolResult = vi.fn();

    await runAgent({
      userMessage: "do a thing",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onToolResult,
      },
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const result = onToolResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.error).toContain("Unknown tool");
    expect(result.error).toContain("frobnicate");
    // Buffer is left unchanged.
    expect(bufferEl.value).toBe("untouched");
  });
});

describe("runAgent — malformed tool arguments (Req 6.5)", () => {
  it("returns an invalid-arguments result and leaves the buffer unchanged", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_bad_args",
            name: "replace_line",
            arguments: "this is not valid json {{{",
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Could not parse the edit.",
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "Could not parse the edit.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "keep me";
    const onToolResult = vi.fn();

    await runAgent({
      userMessage: "rewrite line 1",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onToolResult,
      },
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const result = onToolResult.mock.calls[0][1];
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.error).toContain("invalid tool arguments");
    // Buffer is left unchanged.
    expect(bufferEl.value).toBe("keep me");
  });
});

describe("runAgent — onToolCall documentView numbering (Req 6.6)", () => {
  it("passes 1-based numbered content for the current buffer", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_read",
            name: "get_document",
            arguments: "{}",
          },
        ],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "Read the document.",
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "Read the document.",
        tool_calls: [],
        finish_reason: "stop",
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "alpha\nbeta\ngamma";
    const onToolCall = vi.fn();

    await runAgent({
      userMessage: "read it",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onToolCall,
      },
    });

    expect(onToolCall).toHaveBeenCalledTimes(1);
    const documentView = onToolCall.mock.calls[0][1];
    expect(documentView.numbered).toBe("1| alpha\n2| beta\n3| gamma");
    expect(documentView.lines).toBe(3);
  });

  it("reflects the buffer state at the moment each tool call is issued", async () => {
    // Two calls in one turn: the first mutates the buffer; the second is
    // read-only. The documentView for the second call must reflect the
    // buffer AFTER the first call mutated it.
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: "call_mutate",
            name: "replace_line",
            arguments: JSON.stringify({ line: 1, text: "new" }),
          },
          {
            id: "call_read",
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
      });

    const bufferEl = document.createElement("textarea");
    bufferEl.value = "old";
    const onToolCall = vi.fn();

    await runAgent({
      userMessage: "rewrite then read",
      settings: { system_prompt: "" },
      bufferEl,
      contextAnchor: null,
      callbacks: {
        getDocumentContext: () => ({ text: bufferEl.value, path: null }),
        onToolCall,
      },
    });

    expect(onToolCall).toHaveBeenCalledTimes(2);
    // First call issued while the buffer still held "old".
    expect(onToolCall.mock.calls[0][1].numbered).toBe("1| old");
    // Second call issued after the first mutation set the buffer to "new".
    expect(onToolCall.mock.calls[1][1].numbered).toBe("1| new");
    expect(bufferEl.value).toBe("new");
  });
});
