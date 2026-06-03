// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
}));

import { _internal as inferenceInternal } from "../inference_panel.js";
import { _internal as toolEditorInternal, initToolEditor } from "../tool_editor.js";
import {
  _internal as consoleInternal,
  getSchemaParameterOrder,
  initToolConsole,
  parseToolConsoleCommand,
  runToolConsoleCommand,
  setToolConsoleRuntime,
} from "../tool_console.js";

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
      <div id="tool-console" class="tool-console">
        <div id="tool-console-output" class="tool-console-output"></div>
        <div class="tool-console-input-row">
          <input id="tool-console-input" class="tool-console-input" type="text" />
        </div>
      </div>
    </div>
  `;
}

const INSERT_SCHEMA = [
  {
    type: "function",
    function: {
      name: "insert_text",
      description: "Insert text",
      parameters: {
        type: "object",
        properties: {
          line: { type: "integer" },
          column: { type: "integer" },
          text: { type: "string" },
        },
        required: ["line", "text"],
      },
    },
  },
];

describe("tool_console", () => {
  beforeEach(() => {
    inferenceInternal.resetForTests();
    toolEditorInternal.resetForTests();
    consoleInternal.resetForTests();
    mountToolEditorDom();
    initToolEditor();
    setToolConsoleRuntime({
      getContext: () => ({ text: "hello\nworld", path: "/tmp/doc.txt" }),
      applyResult: vi.fn(),
    });
    initToolConsole();
    toolEditorInternal.setLoadedToolsForTests({
      implementation: [
        "const tools = {",
        "  insert_text: (args, ctx) => {",
        "    const lines = (ctx.text || '').split('\\n');",
        "    const ln = Math.max(1, Math.min(Number(args.line) || 1, lines.length));",
        "    const insert = String(args.text ?? '');",
        "    lines[ln - 1] = insert + (lines[ln - 1] ?? '');",
        "    return { ok: true, changed: true, new_text: lines.join('\\n'), line: ln };",
        "  },",
        "};",
        "async function run(args, ctx) {",
        "  const fn = tools[ctx.toolName];",
        "  return typeof fn === 'function' ? fn(args, ctx) : { ok: false, error: 'missing', changed: false };",
        "}",
      ].join("\n"),
      schema: INSERT_SCHEMA,
    });
    consoleInternal.clearConsoleOutput();
  });

  afterEach(() => {
    inferenceInternal.resetForTests();
    toolEditorInternal.resetForTests();
    consoleInternal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("maps schema parameter order with required fields first", () => {
    expect(getSchemaParameterOrder("insert_text")).toEqual(["line", "text", "column"]);
  });

  it("parses JSON object arguments", () => {
    const parsed = parseToolConsoleCommand('insert_text {"line":2,"text":"!"}');
    expect(parsed).toEqual({
      ok: true,
      name: "insert_text",
      args: { line: 2, text: "!" },
    });
  });

  it("parses positional call syntax from the design mockup", () => {
    const parsed = parseToolConsoleCommand('insert_text(1, "some text")');
    expect(parsed).toEqual({
      ok: true,
      name: "insert_text",
      args: { line: 1, text: "some text" },
    });
  });

  it("runs a tool and prints result lines in the console output", async () => {
    const applyResult = vi.fn();
    setToolConsoleRuntime({
      getContext: () => ({ text: "hello\nworld", path: null }),
      applyResult,
    });

    await runToolConsoleCommand('insert_text(1, "X")');

    expect(applyResult).toHaveBeenCalledWith(
      "insert_text",
      expect.objectContaining({ ok: true, changed: true, new_text: "Xhello\nworld" })
    );

    const output = consoleInternal.getConsoleOutputEl();
    expect(output?.textContent).toContain("> insert_text(1, \"X\")");
    expect(output?.textContent).toContain("document updated");
    expect(output?.textContent).toContain('"ok": true');
  });

  it("focuses the input when the console row is clicked", () => {
    const row = document.querySelector(".tool-console-input-row");
    const input = consoleInternal.getConsoleInputEl();
    expect(row).not.toBeNull();
    expect(input).not.toBeNull();
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(input);
  });

  it("runs on Enter in the console input", async () => {
    const input = consoleInternal.getConsoleInputEl();
    expect(input).not.toBeNull();
    input.value = 'insert_text {"line":2,"text":"!"}';
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    await vi.waitFor(() => {
      expect(consoleInternal.getConsoleOutputEl()?.textContent).toContain("document updated");
    });
    expect(input.value).toBe("");
  });
});
