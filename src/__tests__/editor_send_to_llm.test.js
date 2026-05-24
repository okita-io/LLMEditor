// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — editor.sendToLLM, _handleStreamToken, _handleStreamComplete
// unit tests.
//
// sendToLLM now routes through the agent/tool-use loop rather than the
// streaming path. The streaming infrastructure (_handleStreamToken,
// _handleStreamComplete) still exists for Tauri event handling and is
// tested via direct stream anchor setup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as editor from "../editor.js";

const DEFAULT_SETTINGS = Object.freeze({
  api_url: "http://localhost:1234/v1/chat/completions",
  model: "local-model",
  temperature: 0.2,
  max_tokens: 2048,
  replace_mode: "replace_document",
  system_prompt: "",
});

/** Build the minimal DOM the editor module reaches for. */
function installBuffer(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  return el;
}

/**
 * Capture every `editor:status` CustomEvent dispatched on `document`
 * for the duration of the test. Returns an array of detail.message
 * strings in dispatch order plus a teardown function.
 */
function captureStatusMessages() {
  const messages = [];
  const handler = (e) => {
    if (e && e.detail && typeof e.detail.message === "string") {
      messages.push(e.detail.message);
    }
  };
  document.addEventListener("editor:status", handler);
  return {
    messages,
    teardown: () => document.removeEventListener("editor:status", handler),
  };
}

/**
 * Install a stub Tauri IPC bridge so api.js calls land on a recorder.
 * The agent_turn command returns a simple text response (no tool calls)
 * so the agent loop completes in one turn.
 */
function installTauri({ settings = DEFAULT_SETTINGS, agentResponse } = {}) {
  const calls = [];
  globalThis.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "load_settings") {
          return Promise.resolve(settings);
        }
        if (cmd === "agent_turn") {
          if (agentResponse) return Promise.resolve(agentResponse);
          return Promise.resolve({
            content: "Done.",
            tool_calls: null,
          });
        }
        return Promise.resolve();
      },
    },
  };
  return calls;
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete globalThis.__TAURI__;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.__TAURI__;
});

describe("editor.sendToLLM — empty content short-circuit", () => {
  it("dispatches 'Nothing to send' when buffer is empty", async () => {
    installBuffer("");
    editor.initialize();
    installTauri();
    const cap = captureStatusMessages();

    await editor.sendToLLM();

    expect(cap.messages).toContain("Nothing to send");
    expect(editor._stateForTests().streamActive).toBe(false);
    cap.teardown();
  });
});

describe("editor.sendToLLM — full-buffer path", () => {
  it("sends the entire buffer when no selection exists", async () => {
    const el = installBuffer("hello world");
    editor.initialize();
    el.selectionStart = 5;
    el.selectionEnd = 5; // collapsed caret
    const calls = installTauri();
    const cap = captureStatusMessages();

    await editor.sendToLLM();

    // The agent_turn command should have been called
    const agentCalls = calls.filter((c) => c.cmd === "agent_turn");
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    cap.teardown();
  });
});

describe("editor.sendToLLM — selection path", () => {
  it("sends the selected text when a non-empty selection exists", async () => {
    const el = installBuffer("hello world");
    editor.initialize();
    el.selectionStart = 6;
    el.selectionEnd = 11;
    const calls = installTauri();
    const cap = captureStatusMessages();

    await editor.sendToLLM();

    const agentCalls = calls.filter((c) => c.cmd === "agent_turn");
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
    cap.teardown();
  });
});

describe("editor.sendToLLM — already-in-progress short-circuit", () => {
  it("dispatches 'A request is already in progress' when stream is active", async () => {
    installBuffer("hi");
    editor.initialize();
    editor._beginStream("replace_document");
    const calls = installTauri();
    const cap = captureStatusMessages();

    await editor.sendToLLM();

    expect(cap.messages).toContain("A request is already in progress");
    const agentCalls = calls.filter((c) => c.cmd === "agent_turn");
    expect(agentCalls).toHaveLength(0);
    editor._endStream();
    cap.teardown();
  });
});

describe("editor._handleStreamToken", () => {
  it("applies the fragment via applyLLMResponse using the recorded mode", () => {
    const el = installBuffer("seed");
    editor.initialize();
    el.selectionStart = 4;
    el.selectionEnd = 4;
    editor._beginStream("insert_at_cursor");

    editor._handleStreamToken("Hello");
    editor._handleStreamToken(" world");

    expect(el.value).toBe("seedHello world");
    const anchor = editor._streamAnchorForTests();
    expect(anchor.insertedLength).toBe(11);
    expect(anchor.group.changes).toHaveLength(2);
    editor._endStream();
  });

  it("is a no-op when no stream is active (defensive)", () => {
    const el = installBuffer("seed");
    editor.initialize();

    editor._handleStreamToken("X");

    expect(el.value).toBe("seed");
    expect(editor._stateForTests().streamActive).toBe(false);
  });

  it("ignores empty fragments", () => {
    const el = installBuffer("seed");
    editor.initialize();
    el.selectionStart = 4;
    el.selectionEnd = 4;
    editor._beginStream("insert_at_cursor");
    editor._handleStreamToken("a");
    expect(el.value).toBe("seeda");

    editor._handleStreamToken("");

    expect(el.value).toBe("seeda");
    editor._endStream();
  });
});

describe("editor._handleStreamComplete — clean completion", () => {
  it("re-enables the textarea, clears streamActive, and commits the stream group", () => {
    const el = installBuffer("seed");
    editor.initialize();
    el.selectionStart = 4;
    el.selectionEnd = 4;
    editor._beginStream("insert_at_cursor");
    editor._handleStreamToken("Hello");
    el.disabled = true;
    el.selectionStart = 9;
    el.selectionEnd = 9;
    expect(editor._stateForTests().streamActive).toBe(true);

    editor._handleStreamComplete({ error: null });

    expect(el.disabled).toBe(false);
    expect(editor._stateForTests().streamActive).toBe(false);
    expect(editor._streamAnchorForTests()).toBeNull();
    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].source).toBe("stream");
  });

  it("dispatches an empty status to clear the in-progress indicator", () => {
    const el = installBuffer("seed");
    editor.initialize();
    el.selectionStart = 4;
    el.selectionEnd = 4;
    editor._beginStream("insert_at_cursor");
    editor._handleStreamToken("x");
    el.disabled = true;
    const cap = captureStatusMessages();

    editor._handleStreamComplete({ error: null });

    expect(cap.messages.at(-1)).toBe("");
    cap.teardown();
  });
});

describe("editor._handleStreamComplete — error arm", () => {
  it("re-enables the textarea and dispatches the error reason verbatim", () => {
    const el = installBuffer("seed");
    editor.initialize();
    el.selectionStart = 4;
    el.selectionEnd = 4;
    editor._beginStream("insert_at_cursor");
    editor._handleStreamToken("partial");
    el.disabled = true;
    el.selectionStart = 11;
    el.selectionEnd = 11;
    const cap = captureStatusMessages();

    editor._handleStreamComplete({ error: "stream timed out" });

    expect(el.disabled).toBe(false);
    expect(editor._stateForTests().streamActive).toBe(false);
    expect(cap.messages).toContain("stream timed out");
    expect(el.value).toBe("seedpartial");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(1);
    cap.teardown();
  });

  it("commits even when no tokens arrived (n=0): no group pushed", () => {
    const el = installBuffer("seed");
    editor.initialize();
    el.selectionStart = 4;
    el.selectionEnd = 4;
    editor._beginStream("insert_at_cursor");
    el.disabled = true;
    const cap = captureStatusMessages();

    editor._handleStreamComplete({ error: "connection failed" });

    expect(el.disabled).toBe(false);
    expect(editor._stateForTests().streamActive).toBe(false);
    expect(cap.messages).toContain("connection failed");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    cap.teardown();
  });

  it("handles a missing payload gracefully (treats as clean completion)", () => {
    const el = installBuffer("seed");
    editor.initialize();
    el.selectionStart = 4;
    el.selectionEnd = 4;
    editor._beginStream("insert_at_cursor");
    editor._handleStreamToken("x");
    el.disabled = true;
    const cap = captureStatusMessages();

    editor._handleStreamComplete(undefined);

    expect(el.disabled).toBe(false);
    expect(editor._stateForTests().streamActive).toBe(false);
    cap.teardown();
  });
});
