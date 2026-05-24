// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// AI chat panel — conversation UI separate from the document buffer.

import * as editor from "./editor.js";
import { clearHistory } from "./chat_history.js";
import { extractDocumentEdits } from "./document_edits.js";

let messagesEl = null;
let inputEl = null;
let sendBtn = null;
let clearBtn = null;
let modelEl = null;
/** @type {HTMLElement | null} */
let activeAssistantBubble = null;
/** @type {HTMLElement | null} */
let activeAssistantBody = null;
/** @type {HTMLElement | null} */
let pendingUserBubble = null;

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
 * @param {string} text
 * @returns {HTMLElement | null}
 */
function appendUserMessage(text) {
  if (!messagesEl) return null;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-user";
  bubble.dataset.chatText = text;

  const head = document.createElement("div");
  head.className = "chat-bubble-head";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = "You";
  head.appendChild(label);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "chat-retry-btn";
  retryBtn.hidden = true;
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", () => {
    void retryUserMessage(bubble);
  });
  head.appendChild(retryBtn);

  bubble.appendChild(head);

  const body = document.createElement("div");
  body.className = "chat-bubble-body";
  body.textContent = text;
  bubble.appendChild(body);

  const errorEl = document.createElement("div");
  errorEl.className = "chat-bubble-error";
  errorEl.hidden = true;
  bubble.appendChild(errorEl);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
  pendingUserBubble = bubble;
  return bubble;
}

/**
 * @param {HTMLElement} bubble
 * @returns {void}
 */
function clearUserBubbleFailure(bubble) {
  bubble.classList.remove("chat-bubble-failed");
  const retryBtn = bubble.querySelector(".chat-retry-btn");
  const errorEl = bubble.querySelector(".chat-bubble-error");
  if (retryBtn) retryBtn.hidden = true;
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
}

/**
 * @param {string} [error]
 * @returns {void}
 */
function markPendingUserBubbleFailed(error) {
  if (!pendingUserBubble) return;
  pendingUserBubble.classList.add("chat-bubble-failed");
  const retryBtn = pendingUserBubble.querySelector(".chat-retry-btn");
  const errorEl = pendingUserBubble.querySelector(".chat-bubble-error");
  if (retryBtn) retryBtn.hidden = false;
  if (errorEl) {
    errorEl.textContent =
      typeof error === "string" && error.length > 0 ? error : "Request failed";
    errorEl.hidden = false;
  }
  scrollMessagesToBottom();
}

/**
 * @param {HTMLElement} bubble
 * @returns {Promise<void>}
 */
async function retryUserMessage(bubble) {
  const text = bubble.dataset.chatText;
  if (typeof text !== "string" || text.length === 0) return;
  pendingUserBubble = bubble;
  clearUserBubbleFailure(bubble);
  await editor.retryChatMessage(text);
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
  activeAssistantBubble = null;
  pendingUserBubble = null;
  clearHistory();
}

/**
 * @param {string} text
 * @returns {void}
 */
export function addUserMessage(text) {
  appendUserMessage(text);
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
  let summary;
  if (!result || result.ok !== true) {
    summary = `${name} → error: ${result?.error ?? "failed"}`;
  } else if (result.changed === false) {
    summary = `${name} → no change (document unchanged)`;
  } else {
    summary = `${name} → applied`;
  }
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
  if (!messagesEl) return null;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-assistant";

  const head = document.createElement("div");
  head.className = "chat-bubble-head";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = "Assistant";
  head.appendChild(label);

  const actions = document.createElement("div");
  actions.className = "chat-bubble-actions";
  head.appendChild(actions);

  bubble.appendChild(head);

  const body = document.createElement("div");
  body.className = "chat-bubble-body";
  body.textContent = initialText;
  bubble.appendChild(body);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();

  activeAssistantBubble = bubble;
  activeAssistantBody = body;
  return body;
}

/**
 * @param {HTMLElement} bubble
 * @param {string} assistantText
 * @returns {void}
 */
function attachApplyEditsButton(bubble, assistantText) {
  const edits = extractDocumentEdits(assistantText);
  if (edits.length === 0) return;

  const head = bubble.querySelector(".chat-bubble-head");
  if (!head) return;

  let actions = head.querySelector(".chat-bubble-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "chat-bubble-actions";
    head.appendChild(actions);
  }

  if (actions.querySelector(".chat-apply-edits-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-apply-edits-btn";
  btn.textContent = "Apply to document";
  btn.title = `Apply ${edits.length} edit(s) from this message to the document`;
  btn.addEventListener("click", () => {
    const applied = editor.applyDocumentEdits(edits);
    if (applied > 0) {
      btn.textContent = "Applied";
      btn.disabled = true;
    } else {
      btn.textContent = "No changes applied";
    }
  });
  actions.appendChild(btn);
  scrollMessagesToBottom();
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
  if (activeAssistantBubble && activeAssistantBody) {
    attachApplyEditsButton(
      activeAssistantBubble,
      activeAssistantBody.textContent ?? ""
    );
  }
  activeAssistantBody = null;
  activeAssistantBubble = null;
  setStreamingUi(false);
}

/** @type {boolean} */
let chatListenersAttached = false;

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

  if (sendBtn && !sendBtn.dataset.chatBound) {
    sendBtn.dataset.chatBound = "1";
    sendBtn.addEventListener("click", () => {
      void sendChatPrompt();
    });
  }

  if (inputEl && !inputEl.dataset.chatBound) {
    inputEl.dataset.chatBound = "1";
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendChatPrompt();
      }
    });
  }

  if (clearBtn && !clearBtn.dataset.chatBound) {
    clearBtn.dataset.chatBound = "1";
    clearBtn.addEventListener("click", () => {
      clearMessages();
    });
  }

  if (chatListenersAttached) return;
  chatListenersAttached = true;

  if (typeof document !== "undefined") {
    document.addEventListener("editor:chat-start", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const text =
        detail && typeof detail === "object" && typeof detail.text === "string"
          ? detail.text
          : "";
      if (text.length > 0) appendUserMessage(text);
      activeAssistantBody = null;
      setStreamingUi(true);
    });

    document.addEventListener("editor:chat-retry", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const text =
        detail && typeof detail === "object" && typeof detail.text === "string"
          ? detail.text
          : "";
      if (pendingUserBubble && text.length > 0) {
        clearUserBubbleFailure(pendingUserBubble);
      }
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

    document.addEventListener("editor:chat-unapplied-edits", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const message =
        detail && typeof detail === "object" && typeof detail.message === "string"
          ? detail.message
          : "";
      if (message.length === 0) return;
      const bubble = activeAssistantBubble;
      if (bubble) {
        attachApplyEditsButton(bubble, message);
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

    document.addEventListener("editor:chat-complete", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const success =
        !detail || typeof detail !== "object" || detail.success !== false;

      finalizeAssistantMessage();

      if (!success) {
        const error =
          detail && typeof detail === "object" && typeof detail.error === "string"
            ? detail.error
            : "Request failed";
        markPendingUserBubbleFailed(error);
        return;
      }

      if (pendingUserBubble) {
        clearUserBubbleFailure(pendingUserBubble);
      }
      pendingUserBubble = null;
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

export const _internal = {
  appendUserMessage,
  markPendingUserBubbleFailed,
  clearUserBubbleFailure,
  getPendingUserBubble: () => pendingUserBubble,
};
