// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as editor from "../editor.js";
import {
  initializeChat,
  clearMessages,
  beginAssistantMessage,
  finalizeAssistantMessage,
} from "../chat.js";
import { loadDefaultToolsFixture } from "./setup/default_lmtools_fixture.js";

function installDom() {
  document.body.innerHTML = `
    <aside id="chat-panel">
      <div id="chat-messages"></div>
      <span id="chat-model-label">(no model)</span>
      <textarea id="chat-input"></textarea>
      <button id="chat-send"></button>
      <button id="chat-clear"></button>
      <span id="chat-token-count"></span>
    </aside>
    <textarea id="buffer"></textarea>
  `;
  editor.initialize();
  initializeChat();
}

beforeEach(() => {
  document.body.innerHTML = "";
  loadDefaultToolsFixture();
});

afterEach(() => {
  clearMessages();
});

describe("chat apply document edits", () => {
  it("shows Apply to document when assistant message contains tool-shaped JSON", async () => {
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
    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Applied");
      expect(buffer.value).toContain("build-up");
    });
  });
});
