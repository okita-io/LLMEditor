// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// AI chat panel — conversation UI separate from the document buffer.

import * as editor from "./editor.js";

let messagesEl = null;
let inputEl = null;
let sendBtn = null;
let clearBtn = null;
let modelEl = null;
/** @type {HTMLElement | null} */
let activeAssistantBody = null;

/**
 * @returns {void}
 */
function scrollMessagesToBottom() {
  if (!messagesEl) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * @param {"user"|"assistant"} role
 * @param {string} text
 * @returns {HTMLElement}
 */
function appendBubble(role, text) {
  if (!messagesEl) {
    const stub = document.createElement("div");
    return stub;
  }

  const bubble = document.createElement("div");
  bubble.className =
    role === "user" ? "chat-bubble chat-bubble-user" : "chat-bubble chat-bubble-assistant";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = role === "user" ? "You" : "Assistant";
  bubble.appendChild(label);

  const body = document.createElement("div");
  body.className = "chat-bubble-body";
  body.textContent = text;
  bubble.appendChild(body);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
  return body;
}

/**
 * @param {boolean} streaming
 * @returns {void}
 */
function setStreamingUi(streaming) {
  if (inputEl) inputEl.disabled = streaming;
  if (sendBtn) sendBtn.disabled = streaming;
  if (modelEl) modelEl.classList.toggle("streaming", streaming);
}

/**
 * @param {string} model
 * @returns {void}
 */
export function setModelName(model) {
  if (!modelEl) return;
  modelEl.textContent =
    typeof model === "string" && model.length > 0 ? model : "(no model)";
}

/**
 * @returns {void}
 */
export function clearMessages() {
  if (messagesEl) messagesEl.replaceChildren();
  activeAssistantBody = null;
}

/**
 * @param {string} text
 * @returns {void}
 */
export function addUserMessage(text) {
  appendBubble("user", text);
}

/**
 * @param {string} name
 * @param {string} argsJson
 * @returns {void}
 */
export function appendToolCall(name, argsJson) {
  if (!messagesEl) return;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-tool";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = "Tool";
  bubble.appendChild(label);

  const body = document.createElement("div");
  body.className = "chat-bubble-body chat-tool-body";
  body.textContent = `${name}(${argsJson})`;
  bubble.appendChild(body);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} result
 * @returns {void}
 */
export function appendToolResult(name, result) {
  if (!messagesEl) return;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-tool-result";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = "Result";
  bubble.appendChild(label);

  const body = document.createElement("div");
  body.className = "chat-bubble-body chat-tool-body";
  const summary =
    result && result.ok === true
      ? `${name} → ok`
      : `${name} → ${JSON.stringify(result)}`;
  body.textContent = summary;
  bubble.appendChild(body);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
}

/**
 * @param {string} [initialText]
 * @returns {HTMLElement | null}
 */
export function beginAssistantMessage(initialText = "") {
  activeAssistantBody = appendBubble("assistant", initialText);
  return activeAssistantBody;
}

/**
 * @param {string} fragment
 * @returns {void}
 */
export function appendAssistantFragment(fragment) {
  if (!activeAssistantBody || typeof fragment !== "string" || fragment.length === 0) {
    return;
  }
  activeAssistantBody.textContent += fragment;
  scrollMessagesToBottom();
}

/**
 * @returns {void}
 */
export function finalizeAssistantMessage() {
  activeAssistantBody = null;
  setStreamingUi(false);
}

/**
 * @returns {void}
 */
export function initializeChat() {
  if (typeof document === "undefined") return;

  messagesEl = document.getElementById("chat-messages");
  inputEl = document.getElementById("chat-input");
  sendBtn = document.getElementById("chat-send");
  clearBtn = document.getElementById("chat-clear");
  modelEl = document.getElementById("chat-model");

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      void sendChatPrompt();
    });
  }

  if (inputEl) {
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendChatPrompt();
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearMessages();
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("editor:chat-start", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const text =
        detail && typeof detail === "object" && typeof detail.text === "string"
          ? detail.text
          : "";
      if (text.length > 0) addUserMessage(text);
      activeAssistantBody = null;
      setStreamingUi(true);
    });

    document.addEventListener("editor:chat-assistant", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const message =
        detail && typeof detail === "object" && typeof detail.message === "string"
          ? detail.message
          : "";
      if (message.length === 0) return;
      if (!activeAssistantBody) {
        beginAssistantMessage(message);
      } else {
        activeAssistantBody.textContent = message;
        scrollMessagesToBottom();
      }
    });

    document.addEventListener("editor:tool-call", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const toolCall =
        detail && typeof detail === "object" && detail.toolCall ? detail.toolCall : null;
      if (!toolCall || typeof toolCall.name !== "string") return;
      appendToolCall(toolCall.name, toolCall.arguments ?? "{}");
    });

    document.addEventListener("editor:tool-result", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const toolCall =
        detail && typeof detail === "object" && detail.toolCall ? detail.toolCall : null;
      const result =
        detail && typeof detail === "object" && detail.result ? detail.result : null;
      if (!toolCall || typeof toolCall.name !== "string") return;
      appendToolResult(toolCall.name, result ?? {});
    });

    document.addEventListener("editor:chat-token", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const fragment =
        detail && typeof detail === "object" && typeof detail.fragment === "string"
          ? detail.fragment
          : "";
      appendAssistantFragment(fragment);
    });

    document.addEventListener("editor:chat-complete", () => {
      finalizeAssistantMessage();
    });
  }
}

/**
 * @returns {Promise<void>}
 */
async function sendChatPrompt() {
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (text.length === 0) return;
  inputEl.value = "";
  await editor.sendChatMessage(text);
}
