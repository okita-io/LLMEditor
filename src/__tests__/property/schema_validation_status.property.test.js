// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Property-based test for the extract-tools-to-lmtools feature.
//
// Feature: extract-tools-to-lmtools, Property 9: schema validation status reflects tool definitions
//
// Property 9 — Validates Requirements 4.5, 4.8.
//
// For any array of function tool definitions:
//   - When all entries are valid and have names unique among the array
//     (N >= 1 entries), `applySchemaFromRaw` reports a count of N and marks the
//     schema valid.
//   - When the array contains at least one duplicated tool name, it reports an
//     error identifying the duplicate name(s) and clears the parsed tool set.
//
// `applySchemaFromRaw` is exercised through its public surface: the Schema_Pane
// textarea drives it via `_internal.revalidateSchema()`, and the resulting
// status is read from `getToolFileStatus()` (schemaValid + toolCount, where
// toolCount reflects the parsed tool set), the `getUserTools()` accessor (the
// parsed set itself), and the `#tool-schema-status` element (the displayed
// error text identifying the duplicate name).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("../../api.js", () => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  listModels: vi.fn(),
  listModelsDetailed: vi.fn(),
}));

import { _internal as inferenceInternal } from "../../inference_panel.js";
import {
  _internal,
  initToolEditor,
  getToolFileStatus,
  getUserTools,
} from "../../tool_editor.js";

/** Mount the two-pane tool editor DOM (impl pane left, schema pane right). */
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

/**
 * Set the Schema_Pane contents and run the validation exactly as a user edit
 * would, resetting the editor state first so runs do not leak into each other.
 * @param {string} value
 */
function applySchema(value) {
  // Reset module-level schema state between fast-check runs so the last-valid
  // retention from a prior run cannot bleed into the next assertion.
  _internal.resetForTests();
  document.getElementById("tool-schema-editor").value = value;
  _internal.revalidateSchema();
}

/**
 * Tool name fragment: a non-empty token. Any embedded character is mapped to a
 * safe identifier character so the generated names stay distinct, printable,
 * and free of JSON-escaping surprises. Combined with fc.uniqueArray this yields
 * an array of names unique among themselves.
 */
const toolNameArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.replace(/[^A-Za-z0-9_]/g, "_"))
  .filter((s) => s.length > 0);

/** A function tool definition with the given name. */
function functionDef(name, description = "desc") {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

describe("Property 9: schema validation status reflects tool definitions (Req 4.5, 4.8)", () => {
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

  it("reports a count of N and marks the schema valid for N unique-named valid defs (Req 4.5)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(toolNameArb, { minLength: 1, maxLength: 7 }),
        (names) => {
          const schema = names.map((name) => functionDef(name));
          applySchema(JSON.stringify(schema, null, 2));

          const status = getToolFileStatus();
          const statusEl = document.getElementById("tool-schema-status");

          // Marks the schema valid and reports a count of N.
          expect(status.schemaValid).toBe(true);
          expect(status.toolCount).toBe(names.length);
          expect(getUserTools()).toHaveLength(names.length);

          // The displayed status reflects the count, not an error.
          expect(statusEl.getAttribute("data-state")).toBe("valid");
          expect(statusEl.textContent).toContain(`${names.length} tool`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("reports a duplicate-name error and clears the parsed tool set when a name is duplicated (Req 4.8)", () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(toolNameArb, { minLength: 1, maxLength: 7 })
          .chain((names) =>
            fc.record({
              names: fc.constant(names),
              dupIndex: fc.integer({ min: 0, max: names.length - 1 }),
            })
          ),
        ({ names, dupIndex }) => {
          const dupName = names[dupIndex];
          // Build N unique defs, then inject a second def reusing one name so
          // the array contains at least one duplicated tool name.
          const schema = names.map((name) => functionDef(name));
          schema.push(functionDef(dupName, "duplicate"));

          applySchema(JSON.stringify(schema, null, 2));

          const status = getToolFileStatus();
          const statusEl = document.getElementById("tool-schema-status");

          // Reports an error (not valid).
          expect(status.schemaValid).toBe(false);
          expect(statusEl.getAttribute("data-state")).toBe("error");

          // The error identifies the duplicated name.
          expect(statusEl.textContent.toLowerCase()).toContain("duplicate");
          expect(statusEl.textContent).toContain(dupName);

          // The parsed tool set is cleared.
          expect(status.toolCount).toBe(0);
          expect(getUserTools()).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });
});
