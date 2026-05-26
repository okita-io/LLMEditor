// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — api.js wrapper tests.
//
// Each test installs a fake `window.__TAURI__.core.invoke` that records
// (cmd, args) calls and returns a canned value, then asserts the
// matching wrapper:
//   - delegates to the right command name (Req 15.1-15.7),
//   - passes the right argument bag with camelCase keys,
//   - resolves the command's result verbatim,
//   - rejects with the catalog string when the underlying invoke
//     rejects.
//
// The command names mirror `src-tauri/src/commands.rs`. The
// `cancel_stream` wrapper covers the seventh internal command that
// Task 15 added beyond the Req 15 minimum surface (design.md
// "Keyboard handling": cooperative cancellation entry).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as api from "../api.js";

/** Capture every invoke call so each test can assert command + args. */
function installInvokeStub(impl) {
  const calls = [];
  globalThis.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
        calls.push({ cmd, args });
        return impl(cmd, args);
      },
    },
  };
  return calls;
}

beforeEach(() => {
  delete globalThis.__TAURI__;
});

afterEach(() => {
  delete globalThis.__TAURI__;
});

describe("api.openFile", () => {
  it("invokes open_file with the path argument and returns its result", async () => {
    const calls = installInvokeStub(() => Promise.resolve("hello world"));

    const result = await api.openFile("/tmp/example.txt");

    expect(result).toBe("hello world");
    expect(calls).toEqual([
      { cmd: "open_file", args: { path: "/tmp/example.txt" } },
    ]);
  });

  it("propagates the rejection reason from the backend", async () => {
    installInvokeStub(() => Promise.reject("file is not valid UTF-8"));

    await expect(api.openFile("/tmp/bad.txt")).rejects.toBe(
      "file is not valid UTF-8"
    );
  });
});

describe("api.saveFile", () => {
  it("invokes save_file with the path and contents arguments", async () => {
    const calls = installInvokeStub(() => Promise.resolve());

    const result = await api.saveFile("/tmp/example.txt", "abc");

    expect(result).toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "save_file",
        args: { path: "/tmp/example.txt", contents: "abc" },
      },
    ]);
  });

  it("propagates the rejection reason from the backend", async () => {
    installInvokeStub(() => Promise.reject("could not save file: denied"));

    await expect(api.saveFile("/tmp/x.txt", "x")).rejects.toBe(
      "could not save file: denied"
    );
  });
});

describe("api.callLlm", () => {
  it("invokes call_llm with the text and settings snapshot", async () => {
    const calls = installInvokeStub(() => Promise.resolve("model reply"));
    const settings = {
      api_url: "http://localhost:1234/v1/chat/completions",
      model: "local-model",
      temperature: 0.2,
      max_tokens: 2048,
      replace_mode: "replace_document",
      system_prompt: "",
    };

    const result = await api.callLlm("hello", settings);

    expect(result).toBe("model reply");
    expect(calls).toEqual([
      { cmd: "call_llm", args: { text: "hello", settings } },
    ]);
  });
});

describe("api.streamLlm", () => {
  it("invokes stream_llm with the text and settings snapshot", async () => {
    const calls = installInvokeStub(() => Promise.resolve());
    const settings = {
      api_url: "http://localhost:1234/v1/chat/completions",
      model: "local-model",
      temperature: 0.2,
      max_tokens: 2048,
      replace_mode: "replace_document",
      system_prompt: "",
    };

    await api.streamLlm("hello", settings);

    expect(calls).toEqual([
      { cmd: "stream_llm", args: { text: "hello", settings } },
    ]);
  });

  it("propagates the single-flight rejection reason", async () => {
    installInvokeStub(() => Promise.reject("a stream is already active"));
    await expect(api.streamLlm("hi", {})).rejects.toBe(
      "a stream is already active"
    );
  });
});

describe("api.agentTurn", () => {
  it("invokes agent_turn with messages and settings", async () => {
    const response = {
      content: "ok",
      tool_calls: [],
      finish_reason: "stop",
    };
    const calls = installInvokeStub(() => Promise.resolve(response));
    const messages = [{ role: "user", content: "hello" }];
    const settings = { model: "local-model" };

    const result = await api.agentTurn(messages, settings);

    expect(result).toBe(response);
    expect(calls).toEqual([
      { cmd: "agent_turn", args: { messages, settings } },
    ]);
  });
});

describe("api.cancelStream", () => {
  it("invokes cancel_stream with no arguments", async () => {
    const calls = installInvokeStub(() => Promise.resolve());

    await api.cancelStream();

    expect(calls).toEqual([{ cmd: "cancel_stream", args: undefined }]);
  });
});

describe("api.loadSettings", () => {
  it("invokes load_settings and returns the cached snapshot", async () => {
    const snapshot = {
      api_url: "http://localhost:1234/v1/chat/completions",
      model: "local-model",
      temperature: 0.2,
      max_tokens: 2048,
      replace_mode: "replace_document",
      system_prompt: "",
    };
    const calls = installInvokeStub(() => Promise.resolve(snapshot));

    const result = await api.loadSettings();

    expect(result).toBe(snapshot);
    expect(calls).toEqual([{ cmd: "load_settings", args: undefined }]);
  });
});

describe("api.saveSettings", () => {
  it("invokes save_settings with the settings argument", async () => {
    const calls = installInvokeStub(() => Promise.resolve());
    const next = {
      api_url: "https://example.test/v1/chat/completions",
      model: "next-model",
      temperature: 0.5,
      max_tokens: 1024,
      replace_mode: "insert_at_cursor",
      system_prompt: "",
    };

    await api.saveSettings(next);

    expect(calls).toEqual([
      { cmd: "save_settings", args: { settings: next } },
    ]);
  });

  it("propagates the validation rejection reason", async () => {
    installInvokeStub(() =>
      Promise.reject("settings invalid: temperature: out of range")
    );
    await expect(api.saveSettings({})).rejects.toBe(
      "settings invalid: temperature: out of range"
    );
  });
});

describe("api.listModelsDetailed", () => {
  it("invokes list_models_detailed with the apiUrl argument", async () => {
    const result = [
      {
        id: "a-model",
        loaded: true,
        capabilities: {
          vision: false,
          tool_use: true,
          reasoning: { allowed_options: ["off", "on"], default: "on" },
        },
      },
    ];
    const calls = installInvokeStub(() => Promise.resolve(result));

    const models = await api.listModelsDetailed(
      "http://localhost:1234/v1/chat/completions"
    );

    expect(models).toBe(result);
    expect(calls).toEqual([
      {
        cmd: "list_models_detailed",
        args: { apiUrl: "http://localhost:1234/v1/chat/completions" },
      },
    ]);
  });
});

describe("api missing-bridge guard", () => {
  it("throws a clear error when window.__TAURI__ is absent", async () => {
    delete globalThis.__TAURI__;
    await expect(api.openFile("/tmp/x.txt")).rejects.toThrow(
      /Tauri IPC bridge unavailable/
    );
  });

  it("throws when __TAURI__.core.invoke is missing", async () => {
    globalThis.__TAURI__ = { core: {} };
    await expect(api.loadSettings()).rejects.toThrow(
      /Tauri IPC bridge unavailable/
    );
  });
});
