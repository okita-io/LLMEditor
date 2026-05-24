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
  getSmokeConfig,
  installLmStudioBridge,
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
