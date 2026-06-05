// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
}));

import * as api from "../api.js";
import { _internal as inferenceInternal } from "../inference_panel.js";
import { _internal, initToolEditor, parseToolFileContents, serializeToolFile } from "../tool_editor.js";

function mountToolEditorDom() {
  document.body.innerHTML = `
    <div id="doc-buffer-pane"></div>
    <div id="tool-pane-divider"></div>
    <div id="tool-editor-pane">
      <div id="tool-file-bar">
        <input id="tool-file-name" />
        <button id="tool-load"></button>
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

const SAMPLE_SCHEMA = {
  type: "function",
  function: {
    name: "greet",
    description: "Say hello",
    parameters: { type: "object", properties: {} },
  },
};

describe("tool_editor", () => {
  beforeEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    mountToolEditorDom();
    _internal.setDialogOverrides({
      open: async () => "/tmp/greeting-tools.lmtool",
      save: async () => "/tmp/new-tools.lmtool",
    });
    initToolEditor();
    document.getElementById("tool-impl-editor").value = "async function run(args, ctx) { return { ok: true }; }";
    document.getElementById("tool-schema-editor").value = JSON.stringify(SAMPLE_SCHEMA, null, 2);
    _internal.revalidateSchema();
  });

  afterEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("round-trips implementation and schema through .lmtool split-text format", () => {
    const serialized = serializeToolFile();
    const parsed = parseToolFileContents(serialized);
    expect(parsed.implementation).toContain("async function run");
    expect(JSON.parse(parsed.schema).function.name).toBe("greet");
  });

  it("rejects schema tools with duplicate names", () => {
    document.getElementById("tool-schema-editor").value = JSON.stringify(
      [
        {
          type: "function",
          function: {
            name: "greet",
            description: "Say hello",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function",
          function: {
            name: "greet",
            description: "Duplicate",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      null,
      2
    );
    _internal.revalidateSchema();
    const status = document.getElementById("tool-schema-status");
    expect(status?.getAttribute("data-state")).toBe("error");
    expect(status?.textContent).toContain("duplicate");
  });

  it("loads a tool file into both panes", async () => {
    vi.mocked(api.openFile).mockResolvedValue(
      JSON.stringify({
        version: 1,
        implementation: "async function run(args) { return { ok: true }; }",
        schema: SAMPLE_SCHEMA,
      })
    );

    await _internal.onToolLoad();

    expect(api.openFile).toHaveBeenCalledWith("/tmp/greeting-tools.lmtool");
    expect(document.getElementById("tool-impl-editor").value).toContain("async function run");
    expect(_internal.getCurrentToolPath()).toBe("/tmp/greeting-tools.lmtool");
  });

  it("refreshes syntax highlight overlays when a tool file is loaded", async () => {
    vi.mocked(api.openFile).mockResolvedValue(
      JSON.stringify({
        version: 1,
        implementation: "async function run(args) { return { ok: true }; }",
        schema: SAMPLE_SCHEMA,
      })
    );

    const implCode = document
      .getElementById("tool-impl-editor")
      ?.closest(".tool-code-wrap")
      ?.querySelector("code");
    const schemaCode = document
      .getElementById("tool-schema-editor")
      ?.closest(".tool-code-wrap")
      ?.querySelector("code");

    expect(implCode?.textContent ?? "").not.toContain("async function run");

    await _internal.loadToolFile("/tmp/greeting-tools.lmtool");
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(implCode?.textContent).toContain("async function run");
    expect(implCode?.innerHTML).toContain("hl-keyword");
    expect(schemaCode?.textContent).toContain('"greet"');
    expect(schemaCode?.innerHTML).toContain("hl-key");
  });

  it("save as confirms overwrite when file already exists", async () => {
    vi.mocked(api.openFile).mockImplementation(async (path) => {
      if (path === "/tmp/new-tools.lmtool") return "existing";
      throw new Error("missing");
    });

    const savePromise = _internal.onToolSaveAs();
    await vi.waitFor(() => {
      const modal = document.getElementById("inference-confirm-modal");
      expect(modal).not.toBeNull();
      expect(modal.hidden).toBe(false);
    });
    document.getElementById("inference-confirm-modal").querySelector('[data-action="confirm"]').click();
    await savePromise;

    expect(api.saveFile).toHaveBeenCalledWith(
      "/tmp/new-tools.lmtool",
      expect.stringContaining("// ---- schema ----")
    );
  });

  it("delete clears panes after confirmation", async () => {
    vi.mocked(api.openFile).mockResolvedValue(
      JSON.stringify({ version: 1, implementation: "async function run() {}", schema: SAMPLE_SCHEMA })
    );
    await _internal.loadToolFile("/tmp/greeting-tools.lmtool");
    vi.mocked(api.deleteFile).mockResolvedValue(undefined);

    const deletePromise = _internal.onToolDelete();
    await Promise.resolve();
    document.getElementById("inference-confirm-modal").querySelector('[data-action="confirm"]').click();
    await deletePromise;

    expect(api.deleteFile).toHaveBeenCalledWith("/tmp/greeting-tools.lmtool");
    expect(document.getElementById("tool-impl-editor").value).toBe("");
    expect(_internal.getCurrentToolPath()).toBeNull();
  });
});
