// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
}));

import { _internal as inferenceInternal } from "../inference_panel.js";
import { setTabSpaces } from "../editor_tab_settings.js";
import {
  getLastEditTarget,
  resetEditTargetsForTests,
  setLastEditTarget,
  undoActiveEditTarget,
} from "../edit_target.js";
import { _internal, initToolEditor } from "../tool_editor.js";
import * as editor from "../editor.js";

function mountToolEditorDom() {
  document.body.innerHTML = `
    <div id="doc-buffer-pane"><textarea id="buffer"></textarea></div>
    <div id="tool-pane-divider"></div>
    <div id="tool-editor-pane">
      <div id="tool-file-bar">
        <input id="tool-file-name" />
        <button id="tool-load"></button>
        <button id="tool-reload"></button>
        <button id="tool-save"></button>
        <button id="tool-save-as"></button>
        <button id="tool-delete"></button>
      </div>
      <div id="tool-split-row">
        <div id="tool-impl-pane"><textarea id="tool-impl-editor"></textarea></div>
        <div id="tool-schema-divider"></div>
        <div id="tool-schema-pane">
          <span id="tool-schema-status"></span>
          <textarea id="tool-schema-editor"></textarea>
        </div>
      </div>
    </div>
  `;
}

function pressTab(el) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
  );
}

function typeChar(el, ch) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: ch,
    })
  );
  el.value = el.value.slice(0, start) + ch + el.value.slice(end);
  el.selectionStart = start + ch.length;
  el.selectionEnd = start + ch.length;
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ch,
    })
  );
}

describe("tool editor edit history", () => {
  beforeEach(() => {
    inferenceInternal.resetForTests();
    resetEditTargetsForTests();
    _internal.resetForTests();
    setTabSpaces(4);
    mountToolEditorDom();
    editor.initialize();
    initToolEditor();
  });

  afterEach(() => {
    inferenceInternal.resetForTests();
    resetEditTargetsForTests();
    _internal.resetForTests();
    document.body.innerHTML = "";
  });

  it("inserts tab spaces in the implementation pane using settings", () => {
    const impl = document.getElementById("tool-impl-editor");
    impl.value = "a";
    impl.selectionStart = 1;
    impl.selectionEnd = 1;
    setLastEditTarget("tool-impl");

    pressTab(impl);

    expect(impl.value).toBe("a    ");
    expect(impl.selectionStart).toBe(5);
  });

  it("inserts 2 spaces when tab_spaces is 2", () => {
    setTabSpaces(2);
    const schema = document.getElementById("tool-schema-editor");
    schema.value = "{";
    schema.selectionStart = 1;
    schema.selectionEnd = 1;
    setLastEditTarget("tool-schema");

    pressTab(schema);

    expect(schema.value).toBe("{  ");
  });

  it("undo restores the last edit in the focused tool pane", () => {
    const impl = document.getElementById("tool-impl-editor");
    impl.value = "x";
    impl.selectionStart = 1;
    impl.selectionEnd = 1;
    setLastEditTarget("tool-impl");

    pressTab(impl);
    expect(impl.value).toBe("x    ");

    undoActiveEditTarget();
    expect(impl.value).toBe("x");
  });

  it("routes undo to the schema pane when it was last clicked", () => {
    const impl = document.getElementById("tool-impl-editor");
    const schema = document.getElementById("tool-schema-editor");
    impl.value = "impl";
    schema.value = "schema";
    schema.selectionStart = 6;
    schema.selectionEnd = 6;
    setLastEditTarget("tool-schema");

    pressTab(schema);
    expect(schema.value).toBe("schema    ");

    undoActiveEditTarget();
    expect(schema.value).toBe("schema");
    expect(impl.value).toBe("impl");
  });

  it("clears history when a tool file is loaded", async () => {
    const impl = document.getElementById("tool-impl-editor");
    impl.value = "a";
    impl.selectionStart = 1;
    impl.selectionEnd = 1;
    setLastEditTarget("tool-impl");
    pressTab(impl);

    const { openFile } = await import("../api.js");
    vi.mocked(openFile).mockResolvedValue(
      JSON.stringify({
        version: 1,
        implementation: "loaded",
        schema: { type: "function", function: { name: "x", parameters: {} } },
      })
    );

    await _internal.loadToolFile("/tmp/tools.lmtool");
    expect(impl.value).toBe("loaded");

    undoActiveEditTarget();
    expect(impl.value).toBe("loaded");
  });

  it("records typing edits in the implementation pane", () => {
    const impl = document.getElementById("tool-impl-editor");
    impl.value = "";
    impl.selectionStart = 0;
    impl.selectionEnd = 0;
    setLastEditTarget("tool-impl");

    typeChar(impl, "h");
    typeChar(impl, "i");
    expect(impl.value).toBe("hi");

    undoActiveEditTarget();
    expect(impl.value).toBe("");
  });

  it("sets last edit target when clicking a tool pane", () => {
    const schemaPane = document.getElementById("tool-schema-pane");
    schemaPane.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(getLastEditTarget()).toBe("tool-schema");
  });
});
