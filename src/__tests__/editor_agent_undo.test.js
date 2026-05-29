// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import * as editor from "../editor.js";
import { loadDefaultToolsFixture } from "./setup/default_lmtools_fixture.js";

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, agentTurn: vi.fn() };
});

function installBuffer(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  editor.initialize();
  return el;
}

beforeEach(() => {
  loadDefaultToolsFixture();
  document.body.innerHTML = "";
  globalThis.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
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
        return api[cmd] ? api[cmd](...Object.values(args ?? {})) : Promise.resolve();
      },
    },
  };
  vi.mocked(api.agentTurn).mockReset();
});

afterEach(() => {
  delete globalThis.__TAURI__;
  vi.restoreAllMocks();
});

describe("editor agent undo", () => {
  it("records agent tool edits as a single undo group", async () => {
    vi.mocked(api.agentTurn)
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        content: "done",
        tool_calls: [],
        finish_reason: "stop",
      });

    const el = installBuffer("original");
    await editor.sendChatMessage("update line 1");

    expect(el.value).toBe("updated");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(1);
    expect(editor._undoRedoStateForTests().undoStack[0].source).toBe("agent");

    editor.undo();
    expect(el.value).toBe("original");
  });
});
