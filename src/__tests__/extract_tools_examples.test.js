// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Example / edge-case tests for the non-property acceptance criteria of the
// extract-tools-to-lmtools feature (Task 9.5). These complement the
// property-based tests with concrete, requirement-anchored examples:
//
//   - Two-pane display + status updates ............ Req 4.1, 4.2, 4.3, 4.4
//   - Empty / malformed schema status .............. Req 4.6, 4.7
//   - Request tools equal getAgentToolSchemas() .... Req 3.3, 5.6
//   - Override implementation runs by name ......... Req 3.4, 5.5
//   - editorToolDefinitions() / getAgentTools ...... Req 3.6, 3.7
//   - Chat edit unknown name / no-op ............... Req 9.3

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../api.js", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  listModels: vi.fn(),
  listModelsDetailed: vi.fn(),
}));

import * as api from "../api.js";
import * as toolEditor from "../tool_editor.js";
import {
  _internal,
  initToolEditor,
  getAgentToolSchemas,
  getToolFileStatus,
  executeAgentTool,
} from "../tool_editor.js";
import { _internal as inferenceInternal } from "../inference_panel.js";
import { editorToolDefinitions } from "../editor_tool_schemas.js";
import { buildAgentRequestPreview } from "../agent_request_preview.js";
import { defaultLmStudioSettings } from "../lm_studio_inference.js";
import * as editor from "../editor.js";
import {
  initializeChat,
  clearMessages,
  beginAssistantMessage,
  finalizeAssistantMessage,
} from "../chat.js";
import {
  defaultLmtoolsPath,
  loadDefaultToolsFixture,
} from "./setup/default_lmtools_fixture.js";

const EXPECTED_TOOL_NAMES = [
  "get_document",
  "goto_line",
  "insert_text",
  "replace_line",
  "replace_span",
  "delete_lines",
  "delete_span",
];

/** Mount the two-pane tool editor DOM (impl pane left, schema pane right). */
function mountToolEditorDom() {
  document.body.innerHTML = `
    <div id="doc-buffer-pane"></div>
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

function setSchemaPane(value) {
  const el = document.getElementById("tool-schema-editor");
  el.value = value;
  // Dispatch a real input event so the editor's wired listener revalidates,
  // mirroring how a user edit to the Schema_Pane drives the status update.
  el.dispatchEvent(new Event("input"));
}

function setImplPane(value) {
  const el = document.getElementById("tool-impl-editor");
  el.value = value;
  el.dispatchEvent(new Event("input"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-pane display + status updates (Req 4.1–4.4) and empty/malformed status
// (Req 4.6, 4.7).
// ─────────────────────────────────────────────────────────────────────────────

describe("tool editor two-pane display and status (Req 4.1–4.4, 4.6, 4.7)", () => {
  beforeEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    mountToolEditorDom();
    initToolEditor();
  });

  afterEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("opens the default tools file with implementation left and schema right (Req 4.1, 4.2, 4.3)", async () => {
    const raw = readFileSync(defaultLmtoolsPath, "utf8");
    vi.mocked(api.openFile).mockResolvedValue(raw);

    await _internal.loadToolFile(defaultLmtoolsPath);

    // Req 4.1: implementation source is shown in the Implementation_Pane.
    const implEl = document.getElementById("tool-impl-editor");
    expect(implEl.value).toContain("function run");
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(implEl.value).toContain(`function ${name}`);
    }

    // Req 4.2: the seven schema definitions are shown in the Schema_Pane.
    const schemaEl = document.getElementById("tool-schema-editor");
    for (const name of EXPECTED_TOOL_NAMES) {
      expect(schemaEl.value).toContain(name);
    }

    // Req 4.3: the Implementation_Pane sits to the left of the Schema_Pane,
    // i.e. the schema pane comes after the impl pane in document order.
    const implPane = document.getElementById("tool-impl-pane");
    const schemaPane = document.getElementById("tool-schema-pane");
    const relation = implPane.compareDocumentPosition(schemaPane);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reports a count of seven tools and updates the status when the schema changes (Req 4.4, 4.5)", async () => {
    const raw = readFileSync(defaultLmtoolsPath, "utf8");
    vi.mocked(api.openFile).mockResolvedValue(raw);

    await _internal.loadToolFile(defaultLmtoolsPath);

    const status = document.getElementById("tool-schema-status");
    expect(status.getAttribute("data-state")).toBe("valid");
    expect(status.textContent).toContain("7 tool");

    // Req 4.4: editing the Schema_Pane updates the displayed status to reflect
    // the new content (here: a single valid tool definition).
    setSchemaPane(
      JSON.stringify(
        {
          type: "function",
          function: { name: "solo", description: "one", parameters: { type: "object", properties: {} } },
        },
        null,
        2
      )
    );
    expect(status.getAttribute("data-state")).toBe("valid");
    expect(status.textContent).toContain("1 tool");
  });

  it("reports a count of 0 tools for a schema with no entries (Req 4.6)", () => {
    setSchemaPane("[]");

    const status = document.getElementById("tool-schema-status");
    expect(status.getAttribute("data-state")).toBe("valid");
    expect(status.textContent).toContain("0 tool");
    expect(getToolFileStatus().toolCount).toBe(0);
  });

  it("treats an empty Schema_Pane as zero tools (Req 4.6)", () => {
    setSchemaPane("   ");
    expect(getToolFileStatus().toolCount).toBe(0);
    expect(getAgentToolSchemas()).toEqual([]);
  });

  it("shows an invalid-JSON error status instead of a tool count (Req 4.7)", () => {
    setSchemaPane("{ this is : not valid json");

    const status = document.getElementById("tool-schema-status");
    expect(status.getAttribute("data-state")).toBe("error");
    expect(status.textContent.startsWith("✗")).toBe(true);
    // The error status does not report a tool count.
    expect(status.textContent).not.toContain("tool");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Request tools equal getAgentToolSchemas() after a schema edit (Req 3.3, 5.6).
// ─────────────────────────────────────────────────────────────────────────────

describe("model-request tools reflect the current Schema_Pane (Req 3.3, 5.6)", () => {
  const TWO_TOOL_SCHEMA = [
    {
      type: "function",
      function: { name: "alpha", description: "a", parameters: { type: "object", properties: {} } },
    },
    {
      type: "function",
      function: { name: "beta", description: "b", parameters: { type: "object", properties: {} } },
    },
  ];

  beforeEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    mountToolEditorDom();
    initToolEditor();
  });

  afterEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("sends the edited Schema_Pane tools, equal to getAgentToolSchemas(), to the model (Req 3.3, 5.6)", () => {
    // Edit the Schema_Pane to a fresh two-tool schema (no explicit save).
    setSchemaPane(JSON.stringify(TWO_TOOL_SCHEMA, null, 2));

    const schemas = getAgentToolSchemas();
    expect(schemas.map((t) => t.function.name)).toEqual(["alpha", "beta"]);

    // The agent loop builds requests from getAgentToolSchemas(); the request
    // body must carry exactly those tool definitions.
    const settings = defaultLmStudioSettings();
    const messages = [{ role: "user", content: "hi" }];
    const body = buildAgentRequestPreview(settings, messages, getAgentToolSchemas());

    expect(body.tools).toEqual(schemas);
  });

  it("updates the request tools again when the Schema_Pane changes (Req 5.6)", () => {
    setSchemaPane(JSON.stringify(TWO_TOOL_SCHEMA, null, 2));
    const settings = defaultLmStudioSettings();
    const messages = [{ role: "user", content: "hi" }];

    let body = buildAgentRequestPreview(settings, messages, getAgentToolSchemas());
    expect(body.tools).toHaveLength(2);

    // Reduce the schema to a single tool; the next request reflects the edit.
    setSchemaPane(
      JSON.stringify(
        [
          {
            type: "function",
            function: { name: "alpha", description: "a", parameters: { type: "object", properties: {} } },
          },
        ],
        null,
        2
      )
    );

    body = buildAgentRequestPreview(settings, messages, getAgentToolSchemas());
    expect(body.tools).toEqual(getAgentToolSchemas());
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("alpha");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Override implementation runs by name (Req 3.4, 5.5).
// ─────────────────────────────────────────────────────────────────────────────

describe("override implementation runs by name (Req 3.4, 5.5)", () => {
  beforeEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    mountToolEditorDom();
    initToolEditor();
  });

  afterEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("resolves and runs the function matching the requested tool name (Req 3.4)", async () => {
    setImplPane(
      [
        "const tools = {",
        "  echo: (args) => ({ ok: true, ran: 'echo', value: args.value, changed: false }),",
        "  shout: (args) => ({ ok: true, ran: 'shout', value: String(args.text).toUpperCase(), changed: false }),",
        "};",
      ].join("\n")
    );

    const echoResult = await executeAgentTool("echo", { value: 7 }, {});
    expect(echoResult).toMatchObject({ ok: true, ran: "echo", value: 7 });

    const shoutResult = await executeAgentTool("shout", { text: "hi" }, {});
    expect(shoutResult).toMatchObject({ ok: true, ran: "shout", value: "HI" });
  });

  it("runs the latest unsaved Implementation_Pane edit on the next execution (Req 5.5)", async () => {
    setImplPane("const tools = { calc: (args) => ({ ok: true, out: args.n + 1, changed: false }) };");
    const first = await executeAgentTool("calc", { n: 10 }, {});
    expect(first.out).toBe(11);

    // Edit the implementation without saving; the next execution must use it.
    setImplPane("const tools = { calc: (args) => ({ ok: true, out: args.n * 100, changed: false }) };");
    const second = await executeAgentTool("calc", { n: 10 }, {});
    expect(second.out).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// editorToolDefinitions() routes to getAgentToolSchemas(); getAgentTools is
// removed (Req 3.6, 3.7).
// ─────────────────────────────────────────────────────────────────────────────

describe("accessor wiring and removal (Req 3.6, 3.7)", () => {
  beforeEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    loadDefaultToolsFixture();
  });

  afterEach(() => {
    inferenceInternal.resetForTests();
    _internal.resetForTests();
    vi.clearAllMocks();
  });

  it("editorToolDefinitions() returns getAgentToolSchemas() (Req 3.6)", () => {
    const defs = editorToolDefinitions();
    expect(defs).toEqual(getAgentToolSchemas());
    expect(defs).toHaveLength(7);
    expect(defs.map((t) => t.function.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("the removed getAgentTools accessor is undefined (Req 3.7)", () => {
    expect(toolEditor.getAgentTools).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chat edit with an unknown name / a no-op edit leaves the buffer unchanged and
// indicates the failure with "No changes applied" (Req 9.3).
// ─────────────────────────────────────────────────────────────────────────────

describe("chat-apply unknown / no-op edits (Req 9.3)", () => {
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
    _internal.resetForTests();
    loadDefaultToolsFixture();
  });

  afterEach(() => {
    clearMessages();
    _internal.resetForTests();
    vi.clearAllMocks();
  });

  it("leaves the buffer unchanged when an applied edit names a tool absent from the Tool_File (Req 9.3)", async () => {
    installDom();
    const buffer = document.getElementById("buffer");
    buffer.value = "line1\nline2\nline3";

    const applied = await editor.applyDocumentEdits([
      { name: "frobnicate", args: { line: 1, text: "boom" } },
    ]);

    expect(applied).toBe(0);
    expect(buffer.value).toBe("line1\nline2\nline3");
  });

  it("shows 'No changes applied' for a recognized but no-op chat edit (Req 9.3)", async () => {
    installDom();
    const buffer = document.getElementById("buffer");
    buffer.value = "line1\nline2\nline3";

    // replace_line with text identical to the current line → changed: false.
    beginAssistantMessage(
      'No-op replace:\n```json\n{"tool":"replace_line","line":1,"text":"line1"}\n```'
    );
    finalizeAssistantMessage();

    const btn = document.querySelector(".chat-apply-edits-btn");
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe("Apply to document");

    btn.click();
    await vi.waitFor(() => {
      expect(btn.textContent).toBe("No changes applied");
    });
    expect(buffer.value).toBe("line1\nline2\nline3");
    expect(btn.disabled).toBe(false);
  });
});
