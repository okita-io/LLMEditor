// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — document_edits.js edge case and stability tests.
//
// Covers:
//   - Deduplication of extracted edits
//   - Multiple code blocks in one message
//   - Malformed JSON handling
//   - Mixed inline and fenced edits
//   - Edge cases in normalizeToolObject
//   - assistantTextLooksLikeUnappliedEdits boundary cases

import { describe, expect, it } from "vitest";
import {
  extractDocumentEdits,
  assistantTextLooksLikeUnappliedEdits,
  _internal,
} from "../document_edits.js";

describe("extractDocumentEdits — deduplication", () => {
  it("deduplicates identical edits from multiple code blocks", () => {
    const text = `
\`\`\`json
{"tool": "replace_range", "start_line": 1, "end_line": 1, "text": "new"}
\`\`\`

And again:

\`\`\`json
{"tool": "replace_range", "start_line": 1, "end_line": 1, "text": "new"}
\`\`\`
`;
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
  });

  it("keeps distinct edits from multiple code blocks", () => {
    const text = `
\`\`\`json
{"tool": "replace_range", "start_line": 1, "end_line": 1, "text": "first"}
\`\`\`

\`\`\`json
{"tool": "replace_range", "start_line": 2, "end_line": 2, "text": "second"}
\`\`\`
`;
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(2);
  });
});

describe("extractDocumentEdits — malformed JSON", () => {
  it("ignores truncated JSON in code blocks", () => {
    const text = '```json\n{"tool": "replace_range", "start_line": 1\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(0);
  });

  it("ignores non-JSON content in code blocks", () => {
    const text = "```json\nthis is not json at all\n```";
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(0);
  });

  it("handles empty code blocks", () => {
    const text = "```json\n\n```";
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(0);
  });
});

describe("extractDocumentEdits — array of tool calls", () => {
  it("extracts from an array of tool objects", () => {
    const text = `\`\`\`json
[
  {"tool": "replace_range", "start_line": 1, "end_line": 1, "text": "a"},
  {"tool": "insert_text", "line": 2, "column": 1, "text": "b"}
]
\`\`\``;
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(2);
    expect(edits[0].name).toBe("replace_range");
    expect(edits[1].name).toBe("insert_text");
  });

  it("extracts from tool_calls wrapper object", () => {
    const text = `\`\`\`json
{
  "tool_calls": [
    {"type": "function", "function": {"name": "delete_range", "arguments": "{\\"start_line\\": 3, \\"end_line\\": 3}"}}
  ]
}
\`\`\``;
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("delete_range");
  });
});

describe("extractDocumentEdits — shape detection", () => {
  it("detects replace_line shape when start_line equals end_line", () => {
    const text = '```json\n{"start_line": 5, "end_line": 5, "text": "new content"}\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("replace_line");
    expect(edits[0].source).toBe("replace_line-shape");
  });

  it("detects legacy replace_range shape for multi-line spans", () => {
    const text = '```json\n{"start_line": 5, "end_line": 7, "text": "new content"}\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("replace_range");
    expect(edits[0].source).toBe("replace_range-shape");
  });

  it("detects insert_text shape (line + column + text)", () => {
    const text = '```json\n{"line": 3, "column": 1, "text": "inserted"}\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("insert_text");
    expect(edits[0].source).toBe("insert_text-shape");
  });

  it("detects replace_line shape (line + text without column)", () => {
    const text = '```json\n{"line": 3, "text": "inserted"}\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("replace_line");
    expect(edits[0].source).toBe("replace_line-shape");
  });

  it("detects replace_span shape (line + start_column + end_column + text)", () => {
    const text =
      '```json\n{"line": 2, "start_column": 10, "end_column": 19, "text": "apple"}\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("replace_span");
    expect(edits[0].source).toBe("replace_span-shape");
  });

  it("detects delete_range shape (start_line + end_line, no text)", () => {
    const text = '```json\n{"start_line": 2, "end_line": 4}\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("delete_range");
    expect(edits[0].source).toBe("delete_range-shape");
  });
});

describe("extractDocumentEdits — inline JSON", () => {
  it("extracts inline tool JSON from prose", () => {
    const text =
      'You should use {"tool": "insert_text", "line": 1, "column": 1, "text": "hello"} to add text.';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("insert_text");
  });

  it("extracts name-style inline JSON", () => {
    const text =
      'Call {"name": "replace_line", "arguments": {"line": 1, "text": "x"}} now.';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("replace_line");
  });
});

describe("extractDocumentEdits — function-call style", () => {
  it("extracts replace_line from legacy replace_range function-call shape", () => {
    const text = 'replace_range({"start_line": 2, "end_line": 2, "text": "done"})';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("replace_line");
  });

  it("extracts delete_range({})", () => {
    const text = 'delete_range({"start_line": 1, "end_line": 3})';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("delete_range");
  });
});

describe("extractDocumentEdits — filters non-editor tools", () => {
  it("ignores unknown tool names", () => {
    const text = '```json\n{"tool": "unknown_tool", "arg": "value"}\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(0);
  });

  it("keeps goto_line in extraction", () => {
    const text = '```json\n{"tool": "goto_line", "line": 5}\n```';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("goto_line");
  });
});

describe("extractDocumentEdits — empty/null input", () => {
  it("returns empty array for empty string", () => {
    expect(extractDocumentEdits("")).toHaveLength(0);
  });

  it("returns empty array for null", () => {
    expect(extractDocumentEdits(null)).toHaveLength(0);
  });

  it("returns empty array for undefined", () => {
    expect(extractDocumentEdits(undefined)).toHaveLength(0);
  });

  it("returns empty array for non-string", () => {
    expect(extractDocumentEdits(42)).toHaveLength(0);
  });
});

describe("assistantTextLooksLikeUnappliedEdits", () => {
  it("returns true for text with insert_text JSON", () => {
    const text = '{"tool": "insert_text", "line": 1, "column": 1, "text": "x"}';
    expect(assistantTextLooksLikeUnappliedEdits(text)).toBe(true);
  });

  it("returns true for text with replace_line JSON", () => {
    const text = '{"start_line": 1, "end_line": 1, "text": "x"}';
    expect(assistantTextLooksLikeUnappliedEdits(text)).toBe(true);
  });

  it("returns true for text with replace_span JSON", () => {
    const text = '{"line": 1, "start_column": 2, "end_column": 4, "text": "x"}';
    expect(assistantTextLooksLikeUnappliedEdits(text)).toBe(true);
  });

  it("returns false for delete_range only (no insert/replace)", () => {
    const text = '{"tool": "delete_range", "start_line": 1, "end_line": 1}';
    expect(assistantTextLooksLikeUnappliedEdits(text)).toBe(false);
  });

  it("returns false for plain prose", () => {
    expect(assistantTextLooksLikeUnappliedEdits("I updated the file.")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(assistantTextLooksLikeUnappliedEdits("")).toBe(false);
  });

  it("returns false for code that mentions tools but has no JSON", () => {
    expect(
      assistantTextLooksLikeUnappliedEdits(
        "You can use replace_line to edit lines."
      )
    ).toBe(false);
  });
});

describe("_internal.normalizeToolObject", () => {
  it("normalizes a tool-keyed object", () => {
    const result = _internal.normalizeToolObject({
      tool: "insert_text",
      line: 1,
      column: 1,
      text: "hi",
    });
    expect(result).not.toBeNull();
    expect(result.name).toBe("insert_text");
    expect(result.args.line).toBe(1);
  });

  it("normalizes a name+arguments object", () => {
    const result = _internal.normalizeToolObject({
      name: "replace_range",
      arguments: { start_line: 1, end_line: 1, text: "x" },
    });
    expect(result).not.toBeNull();
    expect(result.name).toBe("replace_range");
  });

  it("returns null for unrecognized shapes", () => {
    const result = _internal.normalizeToolObject({ foo: "bar", baz: 42 });
    expect(result).toBeNull();
  });
});

describe("_internal.editsFromParsedJson", () => {
  it("handles null input", () => {
    expect(_internal.editsFromParsedJson(null)).toHaveLength(0);
  });

  it("handles primitive input", () => {
    expect(_internal.editsFromParsedJson(42)).toHaveLength(0);
    expect(_internal.editsFromParsedJson("string")).toHaveLength(0);
  });

  it("handles empty array", () => {
    expect(_internal.editsFromParsedJson([])).toHaveLength(0);
  });

  it("handles array with non-objects", () => {
    expect(_internal.editsFromParsedJson([1, "two", null])).toHaveLength(0);
  });
});
