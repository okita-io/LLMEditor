// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// OpenAI-compatible editor tool schemas (mirrors src-tauri/src/editor_tools.rs).

/** @returns {Array<{ type: string, function: object }>} */
export function editorToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "get_document",
        description:
          "Return the document with 1-based line numbers. For large files this returns the context window around the selection; line numbers are absolute. Selected lines are marked with >>.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "goto_line",
        description:
          "Move the editor caret to the start of a line (1-based). Returns that line's text.",
        parameters: {
          type: "object",
          properties: {
            line: { type: "integer", description: "1-based line number" },
          },
          required: ["line"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "insert_text",
        description: "Insert text at a 1-based line and column position.",
        parameters: {
          type: "object",
          properties: {
            line: { type: "integer", description: "1-based line number" },
            column: { type: "integer", description: "1-based column (default 1)" },
            text: { type: "string", description: "Text to insert" },
          },
          required: ["line", "text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "replace_range",
        description:
          "Replace an inclusive 1-based line range with new text (may span multiple lines).",
        parameters: {
          type: "object",
          properties: {
            start_line: { type: "integer", description: "First line (1-based)" },
            end_line: { type: "integer", description: "Last line inclusive (1-based)" },
            text: { type: "string", description: "Replacement text" },
          },
          required: ["start_line", "end_line", "text"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete_range",
        description: "Delete an inclusive 1-based line range.",
        parameters: {
          type: "object",
          properties: {
            start_line: { type: "integer", description: "First line (1-based)" },
            end_line: { type: "integer", description: "Last line inclusive (1-based)" },
          },
          required: ["start_line", "end_line"],
          additionalProperties: false,
        },
      },
    },
  ];
}
