// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Live LM Studio smoke tests — skipped unless LLM_SMOKE=1.
//
// Requires a tool-capable model loaded in LM Studio (Qwen2.5-Instruct,
// Llama 3.1+, etc.).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as editor from "../../editor.js";
import {
  getLastRequestBody,
  getSmokeConfig,
  installLmStudioBridge,
  liveAgentTurn,
  liveSimpleCompletion,
  pingLmStudio,
} from "./helpers/lm_studio_client.js";
import {
  setupEditorHarness,
  selectRange,
  selectSubstring,
} from "./helpers/editor_harness.js";

const config = getSmokeConfig();
const smokeEnabled = config.enabled;

describe.skipIf(!smokeEnabled)("LM Studio live smoke", () => {
  beforeAll(async () => {
    const ok = await pingLmStudio(config.apiUrl);
    if (!ok) {
      throw new Error(`LM Studio not reachable at ${config.apiUrl}`);
    }
  }, config.timeoutMs);

  beforeEach(async () => {
    document.body.innerHTML = "";
    await installLmStudioBridge(config);
  });

  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  it("lists a loaded model", async () => {
    const { model } = await installLmStudioBridge(config);
    expect(model).toBeTruthy();
  });

  it("sends inference settings on POST /v1/chat/completions", async () => {
    const { settings } = await installLmStudioBridge(config, {
      settings: {
        stop_strings: "SMOKE_STOP",
        context_overflow_policy: "rolling_window",
        top_k: 40,
        repeat_penalty: 1.15,
        top_p: 0.9,
        min_p: 0.05,
        limit_response_length: true,
        max_tokens: 512,
      },
    });

    await liveAgentTurn(
      [{ role: "user", content: "Reply with exactly: OK" }],
      settings,
      config
    );

    const body = getLastRequestBody();
    expect(body).toBeTruthy();
    expect(body.stop).toEqual(["SMOKE_STOP"]);
    expect(body.lmstudio).toBeUndefined();
    expect(body.top_k).toBe(40);
    expect(body.repeat_penalty).toBe(1.15);
    expect(body.top_p).toBe(0.9);
    expect(body.min_p).toBe(0.05);
    expect(body.max_tokens).toBe(512);
    expect(body.temperature).toBe(config.temperature);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
  }, config.timeoutMs);

  it("sends seed on POST when seed is non-zero", async () => {
    const { settings } = await installLmStudioBridge(config, {
      settings: {
        seed: 123456,
        temperature: 0,
        limit_response_length: true,
        max_tokens: 8,
      },
    });

    await liveSimpleCompletion(
      [{ role: "user", content: "Reply with exactly: OK" }],
      settings,
      config
    );

    const body = getLastRequestBody();
    expect(body?.seed).toBe(123456);
  }, config.timeoutMs);

  it("omits seed on POST when seed is 0", async () => {
    const { settings } = await installLmStudioBridge(config, {
      settings: {
        seed: 0,
        temperature: 0,
        limit_response_length: true,
        max_tokens: 8,
      },
    });

    await liveSimpleCompletion(
      [{ role: "user", content: "Reply with exactly: OK" }],
      settings,
      config
    );

    const body = getLastRequestBody();
    expect(body?.seed).toBeUndefined();
  }, config.timeoutMs);

  it("uses seed for reproducible completions at temperature 0", async () => {
    const { settings } = await installLmStudioBridge(config, {
      settings: {
        seed: 987654,
        temperature: 0,
        top_p_enabled: false,
        min_p_enabled: false,
        repeat_penalty_enabled: false,
        limit_response_length: true,
        max_tokens: 16,
      },
    });

    const messages = [{ role: "user", content: "Reply with exactly one word: pineapple" }];
    const first = await liveSimpleCompletion(messages, settings, config);
    const second = await liveSimpleCompletion(messages, settings, config);

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  }, config.timeoutMs);

  it("replace_line: edits a selected line via chat agent", async () => {
    const doc = "header\nREPLACE_ME\nfooter";
    const el = setupEditorHarness(doc);
    const { start, end } = selectSubstring(doc, "REPLACE_ME");
    selectRange(el, start, end);

    await editor.sendChatMessage(
      "Use replace_line on line 2 only. Set line 2 to exactly: SMOKE_OK"
    );

    expect(el.value).toContain("SMOKE_OK");
    expect(el.value).not.toContain("REPLACE_ME");
    expect(el.value.split("\n")).toEqual(["header", "SMOKE_OK", "footer"]);
  }, config.timeoutMs);

  it("insert_text: adds a line after selection", async () => {
    const doc = "alpha\nbeta\ngamma";
    const el = setupEditorHarness(doc);
    const { start, end } = selectSubstring(doc, "beta");
    selectRange(el, start, end);

    await editor.sendChatMessage(
      "Use insert_text on line 2 column 5 to append the text: -inserted (do not change other lines)"
    );

    expect(el.value).toMatch(/beta-inserted|beta-inserted/);
    expect(el.value).toContain("alpha");
    expect(el.value).toContain("gamma");
  }, config.timeoutMs);

  it("delete_lines: removes a marked line", async () => {
    const doc = "keep\nDELETE_THIS_LINE\nkeep2";
    const el = setupEditorHarness(doc);
    const { start, end } = selectSubstring(doc, "DELETE_THIS_LINE");
    selectRange(el, start, end);

    await editor.sendChatMessage(
      "Use delete_lines to delete line 2 (the selected DELETE_THIS_LINE line). Set start_line and end_line both to 2. Do not modify other lines."
    );

    expect(el.value).not.toContain("DELETE_THIS_LINE");
    expect(el.value.split("\n")).toEqual(["keep", "keep2"]);
  }, config.timeoutMs);

  it("delete_span: removes part of a line", async () => {
    const doc = '"items1":["car", "bike", "motorcycle", "van", "train"],';
    const el = setupEditorHarness(doc);
    const { start, end } = selectSubstring(doc, "motorcycle");
    selectRange(el, start, end);

    await editor.sendChatMessage(
      'Use delete_span on line 1 to delete the word motorcycle (columns 27-36). Do not delete the whole line.'
    );

    expect(el.value).not.toContain("motorcycle");
    expect(el.value).toContain('"items1"');
    expect(el.value).toContain("bike");
    expect(el.value).toContain("van");
    expect(el.value.split("\n")).toHaveLength(1);
  }, config.timeoutMs);

  it("context window: edits far from start in a large document", async () => {
    const head = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`);
    const targetLine = "TARGET_LINE_FOR_SMOKE";
    const tail = Array.from({ length: 80 }, (_, i) => `tail ${i + 1}`);
    const doc = [...head, targetLine, ...tail].join("\n");
    const el = setupEditorHarness(doc);
    const { start, end } = selectSubstring(doc, targetLine);
    selectRange(el, start, end);

    await editor.sendChatMessage(
      "The selected line is near line 81. Use replace_line on that line only to set it to exactly: WINDOW_OK"
    );

    expect(el.value).toContain("WINDOW_OK");
    expect(el.value).not.toContain("TARGET_LINE_FOR_SMOKE");
    expect(el.value.split("\n")[80]).toBe("WINDOW_OK");
  }, config.timeoutMs);

  it("undo: reverts agent tool edits as one step", async () => {
    const doc = "before\nUNDO_TARGET\nafter";
    const el = setupEditorHarness(doc);
    const { start, end } = selectSubstring(doc, "UNDO_TARGET");
    selectRange(el, start, end);
    const before = el.value;

    await editor.sendChatMessage(
      "Use replace_line on line 2 to change it to exactly: CHANGED"
    );

    expect(el.value).not.toBe(before);
    expect(el.value).toContain("CHANGED");

    editor.undo();
    expect(el.value).toBe(before);
  }, config.timeoutMs);
});

describe("LM Studio smoke (disabled hint)", () => {
  it.skipIf(smokeEnabled)("documents how to enable live smoke tests", () => {
    expect(smokeEnabled).toBe(false);
  });
});
