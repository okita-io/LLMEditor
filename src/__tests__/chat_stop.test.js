// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  cancelStream: vi.fn(async () => undefined),
}));

import * as api from "../api.js";
import * as editor from "../editor.js";
import { initializeChat } from "../chat.js";

function installDom() {
  document.body.innerHTML = `
    <aside id="chat-panel">
      <div id="chat-messages"></div>
      <span id="chat-model-label">(no model)</span>
      <textarea id="chat-input"></textarea>
      <button id="chat-send"></button>
      <button id="chat-stop" disabled></button>
      <button id="chat-clear"></button>
      <span id="chat-token-count"></span>
    </aside>
  `;
}

describe("chat Stop button", () => {
  beforeEach(() => {
    installDom();
    vi.mocked(api.cancelStream).mockClear();
    initializeChat();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is disabled until an LLM request is active", () => {
    const stopBtn = document.getElementById("chat-stop");
    expect(stopBtn?.disabled).toBe(true);
  });

  it("enables Stop while the chat agent is active", () => {
    document.dispatchEvent(
      new CustomEvent("editor:llm-request-ui", {
        detail: { chatBusy: true, stopEnabled: true },
      })
    );
    expect(document.getElementById("chat-stop")?.disabled).toBe(false);
  });

  it("enables Stop for a document stream without locking chat input", () => {
    document.dispatchEvent(
      new CustomEvent("editor:llm-request-ui", {
        detail: { chatBusy: false, stopEnabled: true },
      })
    );
    expect(document.getElementById("chat-stop")?.disabled).toBe(false);
    expect(document.getElementById("chat-input")?.disabled).toBe(false);
  });

  it("calls stopActiveRequest when Stop is clicked during a request", () => {
    const stopSpy = vi.spyOn(editor, "stopActiveRequest");
    document.dispatchEvent(
      new CustomEvent("editor:llm-request-ui", {
        detail: { chatBusy: true, stopEnabled: true },
      })
    );
    document.getElementById("chat-stop")?.click();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    stopSpy.mockRestore();
  });
});

describe("editor.stopActiveRequest", () => {
  it("invokes cancelStream when a document stream is active", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<textarea id="buffer" spellcheck="false"></textarea>'
    );
    editor.initialize();
    editor._beginStream("insert_at_cursor");
    editor.stopActiveRequest();
    expect(api.cancelStream).toHaveBeenCalled();
    editor._endStream();
  });
});
