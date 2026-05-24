// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  assistantTextLooksLikeUnappliedEdits,
  extractDocumentEdits,
  _internal,
} from "../document_edits.js";

describe("extractDocumentEdits", () => {
  it("extracts insert_text from fenced JSON", () => {
    const text = `
Here is the edit:

\`\`\`json
{"tool": "insert_text", "line": 5, "column": 3, "text": "\\n  \\"build-up\\": {}"}
\`\`\`
`;
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("insert_text");
    expect(edits[0].args.line).toBe(5);
    expect(edits[0].args.text).toContain("build-up");
  });

  it("extracts replace_range from code block", () => {
    const text = `\`\`\`json
{"start_line": 10, "end_line": 12, "text": "replacement"}
\`\`\``;
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("replace_range");
    expect(edits[0].args.start_line).toBe(10);
  });

  it("extracts OpenAI-style tool_calls array", () => {
    const parsed = [
      {
        type: "function",
        function: {
          name: "insert_text",
          arguments: '{"line":2,"column":1,"text":"hello"}',
        },
      },
    ];
    const edits = _internal.editsFromParsedJson(parsed);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("insert_text");
  });

  it("extracts function-call style insert_text", () => {
    const text =
      'insert_text({"line":5,"column":3,"text":"\\n  \\"build-up\\": {}"})';
    const edits = extractDocumentEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].name).toBe("insert_text");
    expect(edits[0].args.line).toBe(5);
  });

  it("ignores outline JSON without tool shapes", () => {
    const text = `\`\`\`json
{
  "prose": {
    "threshold": {
      "heading": "## Threshold",
      "body": "Tension before the love scene."
    }
  }
}
\`\`\``;
    expect(extractDocumentEdits(text)).toHaveLength(0);
    expect(assistantTextLooksLikeUnappliedEdits(text)).toBe(false);
  });

  it("detects unapplied insert/replace edits in prose", () => {
    const text = 'Use `insert_text` with {"line": 1, "column": 1, "text": "x"}';
    expect(assistantTextLooksLikeUnappliedEdits(text)).toBe(true);
  });
});
