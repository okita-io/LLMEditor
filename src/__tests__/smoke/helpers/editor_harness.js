// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import * as editor from "../../../editor.js";
import { initializeChat, clearMessages } from "../../../chat.js";

/**
 * @param {string} [initialValue]
 * @returns {HTMLTextAreaElement}
 */
export function setupEditorHarness(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  editor.initialize();
  return el;
}

/**
 * Build the full editor + chat panel DOM and initialize both modules so the
 * reasoning-stream DOM events dispatched by the agent are actually rendered
 * into `#chat-messages`. Mirrors the minimal subset of `index.html` that the
 * chat panel's `initializeChat()` queries.
 *
 * @param {string} [initialValue]
 * @returns {{ buffer: HTMLTextAreaElement, messages: HTMLElement }}
 */
export function setupChatHarness(initialValue = "") {
  document.body.innerHTML = `
    <textarea id="buffer"></textarea>
    <aside id="chat-panel">
      <div id="chat-messages" class="chat-messages" role="log" aria-live="polite"></div>
      <div class="chat-input-area">
        <textarea id="chat-input" rows="3"></textarea>
        <div class="chat-send-bar">
          <span id="chat-model-label" class="chat-model-label" aria-label="Model">(no model)</span>
          <span id="chat-context-length" class="chat-context-length">Context Length: —</span>
          <span id="chat-token-count"></span>
          <button id="chat-cap-vision" type="button" data-state="unsupported"></button>
          <button id="chat-cap-tools" type="button" data-state="unsupported"></button>
          <button id="chat-cap-reasoning" type="button" data-state="unsupported"></button>
          <button id="chat-send" type="button">Send</button>
          <button id="chat-clear" type="button">Clear</button>
        </div>
      </div>
    </aside>`;
  const buffer = /** @type {HTMLTextAreaElement} */ (
    document.getElementById("buffer")
  );
  buffer.value = initialValue;
  editor.initialize();
  initializeChat();
  clearMessages();
  return { buffer, messages: document.getElementById("chat-messages") };
}

/**
 * @param {HTMLTextAreaElement} el
 * @param {number} start
 * @param {number} end
 * @returns {void}
 */
export function selectRange(el, start, end) {
  el.focus();
  el.selectionStart = start;
  el.selectionEnd = end;
}

/**
 * @param {string} doc
 * @param {string} needle
 * @returns {{ start: number, end: number }}
 */
export function selectSubstring(doc, needle) {
  const start = doc.indexOf(needle);
  if (start < 0) {
    throw new Error(`substring not found for selection: ${needle}`);
  }
  return { start, end: start + needle.length };
}
