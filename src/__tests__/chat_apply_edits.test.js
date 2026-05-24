// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as editor from "../editor.js";
import {
  initializeChat,
  clearMessages,
  beginAssistantMessage,
  finalizeAssistantMessage,
} from "../chat.js";

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
});

describe("chat apply document edits", () => {
  it("shows Apply to document when assistant message contains tool-shaped JSON", () => {
    installDom();
    const buffer = document.getElementById("buffer");
    buffer.value = "line1\nline2\nline3\nline4\nline5";

    beginAssistantMessage(
      'Add build-up:\n```json\n{"tool":"insert_text","line":5,"column":1,"text":"\\n  \\"build-up\\": {}"}\n```'
    );
    finalizeAssistantMessage();

    const btn = document.querySelector(".chat-apply-edits-btn");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Apply to document");

    btn.click();
    expect(btn.textContent).toBe("Applied");
    expect(buffer.value).toContain("build-up");
  });
});
