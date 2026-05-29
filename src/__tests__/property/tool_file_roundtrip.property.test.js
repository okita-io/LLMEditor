// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Property-based test for the extract-tools-to-lmtools feature.
//
// Feature: extract-tools-to-lmtools, Property 1: Tool_File save/load round-trip
//
// Property 1 — Validates: Requirements 8.1, 1.6, 5.3
//
// For any Tool_File contents produced by the Tool_Editor (any implementation
// string and any schema array of function tool definitions), serializing the
// file and then parsing it again yields:
//   (a) an implementation string character-for-character identical to the
//       in-editor Tool_Implementation, and
//   (b) a schema deep-structurally equal to the in-editor Tool_Schema, with
//       tool definitions in the same order and the same fields and values.
//
// The round-trip mirrors how the editor actually serializes/parses:
//   serializeToolFile() reads the live Implementation_Pane and Schema_Pane
//   textareas and emits `{ version, implementation, schema }` where `schema`
//   is the *parsed* JSON of the Schema_Pane.
//   parseToolFileContents(raw) returns `{ implementation: string, schema: string }`
//   where `schema` is re-stringified JSON. We therefore compare the parsed
//   JSON of `parsed.schema` against the original schema array.

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

import {
  _internal,
  initToolEditor,
  parseToolFileContents,
  serializeToolFile,
} from "../../tool_editor.js";

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

// JSON-safe scalar values for schema parameter properties. Doubles are
// intentionally excluded so the JSON round-trip stays exact (no -0/Infinity/NaN
// edge cases that would obscure the structural-fidelity property under test).
const jsonScalar = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null)
);

// A JSON Schema-ish `parameters` object (arbitrary but JSON-serializable).
const parametersArb = fc.record({
  type: fc.constant("object"),
  properties: fc.dictionary(
    fc.string({ minLength: 1 }),
    fc.record({
      type: fc.constantFrom("string", "number", "integer", "boolean", "array"),
      description: fc.string(),
      default: jsonScalar,
    })
  ),
  required: fc.array(fc.string({ minLength: 1 }), { maxLength: 5 }),
});

// A single OpenAI-compatible function tool definition.
const functionToolArb = fc.record({
  type: fc.constant("function"),
  function: fc.record({
    name: fc.string({ minLength: 1 }),
    description: fc.string(),
    parameters: parametersArb,
  }),
});

// A schema array of function tool definitions (0..8 entries).
const schemaArrayArb = fc.array(functionToolArb, { maxLength: 8 });

// Arbitrary implementation source: multi-line strings joined with "\n" so the
// generator covers blank, single- and multi-line implementations. Newlines are
// preserved verbatim by <textarea>.value; "\r" is intentionally not generated
// (fc.string() emits printable ASCII) to avoid textarea CR normalization, which
// is a DOM concern unrelated to the serialize/parse round-trip.
const implementationArb = fc
  .array(fc.string(), { maxLength: 30 })
  .map((lines) => lines.join("\n"));

describe("Property 1: Tool_File save/load round-trip (Req 8.1, 1.6, 5.3)", () => {
  beforeEach(() => {
    mountToolEditorDom();
    initToolEditor();
  });

  afterEach(() => {
    _internal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("serialize→parse preserves implementation verbatim and schema structurally", () => {
    const implEl = document.getElementById("tool-impl-editor");
    const schemaEl = document.getElementById("tool-schema-editor");

    fc.assert(
      fc.property(implementationArb, schemaArrayArb, (implementation, schema) => {
        // Populate the two editor panes exactly as a user authoring a Tool_File
        // would, then save (serialize) and reload (parse).
        implEl.value = implementation;
        schemaEl.value = JSON.stringify(schema);

        const serialized = serializeToolFile();
        const parsed = parseToolFileContents(serialized);

        // (a) implementation is character-for-character identical.
        expect(parsed.implementation).toBe(implementation);

        // (b) schema is deep-structurally equal, same order/fields/values.
        // parseToolFileContents returns the schema as a JSON *string*, so we
        // compare the parsed JSON against the original array.
        expect(JSON.parse(parsed.schema)).toEqual(schema);
      }),
      { numRuns: 100 }
    );
  });
});
