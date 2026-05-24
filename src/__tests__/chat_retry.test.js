// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import * as editor from "../editor.js";
import { initializeChat, _internal } from "../chat.js";
import { clearHistory, getHistoryForAgent } from "../chat_history.js";

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, agentTurn: vi.fn() };
});

function installDom() {
  document.body.innerHTML = `
    <aside id="chat-panel">
      <span id="chat-model"></span>
      <div id="chat-messages"></div>
      <textarea id="chat-input"></textarea>
      <button id="chat-send"></button>
      <button id="chat-clear"></button>
    </aside>
    <textarea id="buffer"></textarea>
  `;
  editor.initialize();
  initializeChat();
}

beforeEach(() => {
  document.body.innerHTML = "";
  globalThis.__TAURI__ = {
    core: {
      invoke: (cmd) => {
        if (cmd === "load_settings") {
          return Promise.resolve({
            api_url: "http://localhost:1234/v1/chat/completions",
            model: "local-model",
            temperature: 0.2,
            max_tokens: 2048,
            replace_mode: "replace_document",
            system_prompt: "",
          });
        }
        return Promise.resolve();
      },
    },
  };
  vi.mocked(api.agentTurn).mockReset();
});

afterEach(() => {
  clearHistory();
  delete globalThis.__TAURI__;
  vi.restoreAllMocks();
});

describe("chat retry on agent failure", () => {
  it("shows Retry on the user bubble when the agent request fails", async () => {
    vi.mocked(api.agentTurn).mockRejectedValue(new Error("connection failed"));
    installDom();

    await editor.sendChatMessage("fix line 1");

    const bubble = _internal.getPendingUserBubble();
    expect(bubble).not.toBeNull();
    expect(bubble?.classList.contains("chat-bubble-failed")).toBe(true);
    const retryBtn = bubble?.querySelector(".chat-retry-btn");
    expect(retryBtn?.hidden).toBe(false);
    const errorEl = bubble?.querySelector(".chat-bubble-error");
    expect(errorEl?.textContent).toBe("connection failed");
    expect(errorEl?.hidden).toBe(false);
  });

  it("retries without creating a duplicate user bubble", async () => {
    vi.mocked(api.agentTurn)
      .mockRejectedValueOnce(new Error("stream timed out"))
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

    installDom();
    await editor.sendChatMessage("hello");

    let messages = document.querySelectorAll(".chat-bubble-user");
    expect(messages.length).toBe(1);

    const retryBtn = messages[0].querySelector(".chat-retry-btn");
    expect(retryBtn).not.toBeNull();
    retryBtn?.click();
    await vi.waitFor(() => expect(api.agentTurn).toHaveBeenCalledTimes(3));

    messages = document.querySelectorAll(".chat-bubble-user");
    expect(messages.length).toBe(1);
    expect(messages[0].classList.contains("chat-bubble-failed")).toBe(false);
    expect(retryBtn?.hidden).toBe(true);
  });

  it("clears Retry after a successful response", async () => {
    vi.mocked(api.agentTurn).mockResolvedValue({
      content: "All good.",
      tool_calls: [],
      finish_reason: "stop",
    });

    installDom();
    await editor.sendChatMessage("hello");

    const bubble = _internal.getPendingUserBubble();
    expect(bubble).toBeNull();
    const retryBtn = document.querySelector(".chat-retry-btn");
    expect(retryBtn?.hidden ?? true).toBe(true);
  });

  it("does not record failed attempts in chat history", async () => {
    vi.mocked(api.agentTurn).mockRejectedValue(new Error("connection failed"));
    installDom();

    await editor.sendChatMessage("remove item A");

    expect(getHistoryForAgent()).toEqual([]);
  });

  it("records one exchange after a successful retry", async () => {
    vi.mocked(api.agentTurn)
      .mockRejectedValueOnce(new Error("stream timed out"))
      .mockResolvedValueOnce({
        content: "Removed item A.",
        tool_calls: [],
        finish_reason: "stop",
      })
      .mockResolvedValueOnce({
        content: "Removed item A.",
        tool_calls: [],
        finish_reason: "stop",
      });

    installDom();
    await editor.sendChatMessage("remove item A");

    const retryBtn = document.querySelector(".chat-retry-btn");
    retryBtn?.click();
    await vi.waitFor(() => expect(api.agentTurn).toHaveBeenCalledTimes(3));

    expect(getHistoryForAgent()).toEqual([
      { role: "user", content: "remove item A" },
      { role: "assistant", content: "Removed item A." },
    ]);
  });
});
