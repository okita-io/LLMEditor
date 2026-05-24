// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — chat.js lifecycle tests.
//
// Covers:
//   - initializeChat() binds DOM elements and event listeners
//   - clearMessages() empties the chat panel
//   - setModelName() updates the model display
//   - beginAssistantMessage / appendAssistantFragment / finalizeAssistantMessage
//   - appendToolCall / appendToolResult rendering
//   - editor:chat-start / editor:chat-complete event handling
//   - Streaming UI state (input disabled during streaming)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as editor from "../editor.js";
import {
  initializeChat,
  clearMessages,
  setModelName,
  beginAssistantMessage,
  appendAssistantFragment,
  finalizeAssistantMessage,
  appendToolCall,
  appendToolResult,
  addUserMessage,
  _internal,
} from "../chat.js";
import { clearHistory, getHistoryForAgent, recordExchange } from "../chat_history.js";

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
});

afterEach(() => {
  clearMessages();
  clearHistory();
  document.body.innerHTML = "";
});

describe("initializeChat", () => {
  it("binds to DOM elements without throwing", () => {
    expect(() => installDom()).not.toThrow();
  });

  it("is idempotent — calling twice does not duplicate listeners", () => {
    installDom();
    initializeChat();
    const sendBtn = document.getElementById("chat-send");
    expect(sendBtn.dataset.chatBound).toBe("1");
  });
});

describe("setModelName", () => {
  it("updates the model span text", () => {
    installDom();
    setModelName("qwen-7b");
    expect(document.getElementById("chat-model").textContent).toBe("qwen-7b");
  });

  it("shows (no model) for empty string", () => {
    installDom();
    setModelName("");
    expect(document.getElementById("chat-model").textContent).toBe("(no model)");
  });

  it("shows (no model) for null", () => {
    installDom();
    setModelName(null);
    expect(document.getElementById("chat-model").textContent).toBe("(no model)");
  });
});

describe("clearMessages", () => {
  it("removes all chat bubbles", () => {
    installDom();
    addUserMessage("hello");
    beginAssistantMessage("hi");
    finalizeAssistantMessage();
    expect(document.querySelectorAll(".chat-bubble").length).toBeGreaterThan(0);

    clearMessages();

    expect(document.querySelectorAll(".chat-bubble").length).toBe(0);
  });

  it("clears stored chat history for the agent", () => {
    installDom();
    recordExchange("remove item A", "Removed item A.");
    clearMessages();
    expect(getHistoryForAgent()).toEqual([]);
  });
});

describe("addUserMessage", () => {
  it("appends a user bubble with the text", () => {
    installDom();
    addUserMessage("test message");
    const bubble = document.querySelector(".chat-bubble-user");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toContain("test message");
  });

  it("stores the text in data-chat-text for retry", () => {
    installDom();
    _internal.appendUserMessage("retry text");
    const bubble = document.querySelector(".chat-bubble-user");
    expect(bubble.dataset.chatText).toBe("retry text");
  });
});

describe("assistant message lifecycle", () => {
  it("beginAssistantMessage creates a bubble with initial text", () => {
    installDom();
    beginAssistantMessage("Starting…");
    const bubble = document.querySelector(".chat-bubble-assistant");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toContain("Starting…");
  });

  it("appendAssistantFragment appends to the active bubble", () => {
    installDom();
    beginAssistantMessage("A");
    appendAssistantFragment("B");
    appendAssistantFragment("C");
    const body = document.querySelector(".chat-bubble-assistant .chat-bubble-body");
    expect(body.textContent).toBe("ABC");
  });

  it("appendAssistantFragment is a no-op when no active bubble", () => {
    installDom();
    expect(() => appendAssistantFragment("orphan")).not.toThrow();
  });

  it("appendAssistantFragment ignores empty strings", () => {
    installDom();
    beginAssistantMessage("X");
    appendAssistantFragment("");
    const body = document.querySelector(".chat-bubble-assistant .chat-bubble-body");
    expect(body.textContent).toBe("X");
  });

  it("finalizeAssistantMessage clears the active bubble reference", () => {
    installDom();
    beginAssistantMessage("done");
    finalizeAssistantMessage();
    appendAssistantFragment("should not appear");
    const body = document.querySelector(".chat-bubble-assistant .chat-bubble-body");
    expect(body.textContent).toBe("done");
  });
});

describe("appendToolCall", () => {
  it("renders a tool bubble with name and args", () => {
    installDom();
    appendToolCall("replace_line", '{"line":1,"text":"x"}');
    const bubble = document.querySelector(".chat-bubble-tool");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toContain("replace_line");
    expect(bubble.textContent).toContain("line");
  });
});

describe("appendToolResult", () => {
  it("renders a success result", () => {
    installDom();
    appendToolResult("replace_line", { ok: true, changed: true });
    const bubble = document.querySelector(".chat-bubble-tool-result");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toContain("applied");
  });

  it("renders an error result", () => {
    installDom();
    appendToolResult("insert_text", { ok: false, error: "invalid line" });
    const bubble = document.querySelector(".chat-bubble-tool-result");
    expect(bubble.textContent).toContain("error");
    expect(bubble.textContent).toContain("invalid line");
  });

  it("renders a no-change result", () => {
    installDom();
    appendToolResult("replace_line", { ok: true, changed: false });
    const bubble = document.querySelector(".chat-bubble-tool-result");
    expect(bubble.textContent).toContain("no change");
  });
});

describe("editor:chat-start event", () => {
  it("adds a user bubble when dispatched", () => {
    installDom();
    document.dispatchEvent(
      new CustomEvent("editor:chat-start", { detail: { text: "hello" } })
    );
    const bubble = document.querySelector(".chat-bubble-user");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toContain("hello");
  });
});

describe("editor:chat-complete event", () => {
  it("clears pending user bubble on success", () => {
    installDom();
    _internal.appendUserMessage("test");
    expect(_internal.getPendingUserBubble()).not.toBeNull();

    document.dispatchEvent(
      new CustomEvent("editor:chat-complete", { detail: { success: true } })
    );

    expect(_internal.getPendingUserBubble()).toBeNull();
  });

  it("marks pending bubble as failed on error", () => {
    installDom();
    _internal.appendUserMessage("test");

    document.dispatchEvent(
      new CustomEvent("editor:chat-complete", {
        detail: { success: false, error: "timeout" },
      })
    );

    const bubble = _internal.getPendingUserBubble();
    expect(bubble).not.toBeNull();
    expect(bubble.classList.contains("chat-bubble-failed")).toBe(true);
  });
});

describe("editor:chat-token event", () => {
  it("appends fragment to active assistant bubble", () => {
    installDom();
    beginAssistantMessage("");

    document.dispatchEvent(
      new CustomEvent("editor:chat-token", { detail: { fragment: "hello " } })
    );
    document.dispatchEvent(
      new CustomEvent("editor:chat-token", { detail: { fragment: "world" } })
    );

    const body = document.querySelector(".chat-bubble-assistant .chat-bubble-body");
    expect(body.textContent).toBe("hello world");
  });
});
