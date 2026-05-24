// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import * as editor from "../editor.js";
import { clearHistory } from "../chat_history.js";

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, agentTurn: vi.fn() };
});

function installDom() {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  editor.initialize();
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

describe("editor chat history", () => {
  it("passes prior turns to the agent on follow-up messages", async () => {
    /** @type {Array<Array<Record<string, unknown>>>} */
    const capturedMessages = [];
    vi.mocked(api.agentTurn).mockImplementation(async (messages) => {
      capturedMessages.push(messages.map((message) => ({ ...message })));
      if (capturedMessages.length === 1) {
        return {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              name: "replace_line",
              arguments: JSON.stringify({
                line: 1,
                text: "updated",
              }),
            },
          ],
          finish_reason: "tool_calls",
        };
      }
      return {
        content: "Removed item A.",
        tool_calls: [],
        finish_reason: "stop",
      };
    });

    installDom();
    const buffer = document.getElementById("buffer");
    buffer.value = "item A";

    await editor.sendChatMessage("remove item A");

    vi.mocked(api.agentTurn).mockImplementation(async (messages) => {
      capturedMessages.push(messages.map((message) => ({ ...message })));
      return {
        content: "Restored item A.",
        tool_calls: [],
        finish_reason: "stop",
      };
    });

    await editor.sendChatMessage("put item A back");

    const followUpMessages = capturedMessages.find((messages) =>
      messages.some(
        (message) =>
          message.role === "user" &&
          String(message.content).includes("User request: put item A back")
      )
    );
    expect(followUpMessages).toEqual(
      expect.arrayContaining([
        { role: "user", content: "remove item A" },
        { role: "assistant", content: "Removed item A." },
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("User request: put item A back"),
        }),
      ])
    );
  });
});
