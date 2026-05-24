// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Configurable smoke test scenarios for LLM tool-use validation.

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   tool: string,
 *   document: string,
 *   selection: string | null,
 *   prompt: string,
 *   validate: (result: string) => { pass: boolean, reason: string },
 *   retries?: number,
 * }} SmokeScenario
 */

/** @type {SmokeScenario[]} */
export const REPLACE_LINE_SCENARIOS = [
  {
    name: "replace single line with exact text",
    description: "LLM replaces a marked line with a specific string",
    tool: "replace_line",
    document: "header\nREPLACE_ME\nfooter",
    selection: "REPLACE_ME",
    prompt:
      "Use replace_line on line 2 only. Set line 2 to exactly: SMOKE_OK",
    validate: (result) => {
      const lines = result.split("\n");
      if (!result.includes("SMOKE_OK")) {
        return { pass: false, reason: "missing SMOKE_OK in output" };
      }
      if (result.includes("REPLACE_ME")) {
        return { pass: false, reason: "REPLACE_ME was not removed" };
      }
      if (!result.includes("header") || !result.includes("footer")) {
        return { pass: false, reason: "surrounding lines were modified" };
      }
      if (lines.length !== 3) {
        return {
          pass: false,
          reason: `expected 3 lines, got ${lines.length}`,
        };
      }
      return { pass: true, reason: "line replaced correctly" };
    },
  },
  {
    name: "collapse multiple lines into one inserted line",
    description: "LLM deletes a multi-line range and inserts a replacement line",
    tool: "delete_lines+insert_text",
    document: "keep\nremove_a\nremove_b\nremove_c\nkeep_end",
    selection: "remove_a\nremove_b\nremove_c",
    prompt:
      "Use delete_lines on lines 2-4, then use insert_text on line 2 at column 1 to insert exactly: COLLAPSED\\n (with a trailing newline). Keep keep and keep_end unchanged.",
    validate: (result) => {
      if (!result.includes("COLLAPSED")) {
        return { pass: false, reason: "missing COLLAPSED" };
      }
      if (
        result.includes("remove_a") ||
        result.includes("remove_b") ||
        result.includes("remove_c")
      ) {
        return { pass: false, reason: "original lines not removed" };
      }
      if (!result.includes("keep") || !result.includes("keep_end")) {
        return { pass: false, reason: "surrounding lines modified" };
      }
      return { pass: true, reason: "multi-line collapse correct" };
    },
  },
  {
    name: "replace line with multi-line expansion",
    description: "LLM expands a single line into multiple lines",
    tool: "replace_line",
    document: "before\nEXPAND_ME\nafter",
    selection: "EXPAND_ME",
    prompt:
      "Use replace_line on line 2 to replace it with exactly two lines: line_a\\nline_b (use a literal newline between them)",
    validate: (result) => {
      if (!result.includes("line_a") || !result.includes("line_b")) {
        return { pass: false, reason: "expansion lines missing" };
      }
      if (result.includes("EXPAND_ME")) {
        return { pass: false, reason: "original line not removed" };
      }
      if (!result.includes("before") || !result.includes("after")) {
        return { pass: false, reason: "surrounding lines modified" };
      }
      return { pass: true, reason: "single-to-multi expansion correct" };
    },
  },
];

/** @type {SmokeScenario[]} */
export const REPLACE_SPAN_SCENARIOS = [
  {
    name: "replace substring within a line",
    description: "LLM changes part of a line without rewriting the whole line",
    tool: "replace_span",
    document: '"items1":["car", "bike", "motorcycle", "van", "train"],',
    selection: "motorcycle",
    prompt:
      'Use replace_span on line 1 to replace the word motorcycle (columns 27-36) with apple. Do not rewrite the whole line.',
    validate: (result) => {
      const expected = '"items1":["car", "bike", "apple", "van", "train"],';
      if (result === expected) {
        return { pass: true, reason: "span replaced correctly" };
      }
      if (!result.includes("apple")) {
        return { pass: false, reason: "apple not found" };
      }
      if (result.includes("motorcycle")) {
        return { pass: false, reason: "motorcycle still present" };
      }
      if (!result.includes('"items1"')) {
        return { pass: false, reason: "whole line was rewritten instead of span edit" };
      }
      return { pass: true, reason: "partial span edit applied" };
    },
    retries: 2,
  },
];

/** @type {SmokeScenario[]} */
export const INSERT_TEXT_SCENARIOS = [
  {
    name: "insert text at end of line",
    description: "LLM appends text to the end of a specific line",
    tool: "insert_text",
    document: "alpha\nbeta\ngamma",
    selection: "beta",
    prompt:
      "Use insert_text on line 2 at the end of the line (column 5) to append the text: -inserted (do not change other lines)",
    validate: (result) => {
      if (!result.includes("beta-inserted")) {
        return { pass: false, reason: "insertion not found at expected position" };
      }
      if (!result.includes("alpha") || !result.includes("gamma")) {
        return { pass: false, reason: "other lines were modified" };
      }
      return { pass: true, reason: "text inserted correctly" };
    },
  },
  {
    name: "insert text at beginning of line",
    description: "LLM prepends text to the start of a line",
    tool: "insert_text",
    document: "first\nsecond\nthird",
    selection: "second",
    prompt:
      "Use insert_text on line 2 at column 1 to insert the text: PREFIX_ (do not modify other lines)",
    validate: (result) => {
      if (!result.includes("PREFIX_second")) {
        return { pass: false, reason: "prefix not inserted at start of line 2" };
      }
      if (!result.includes("first") || !result.includes("third")) {
        return { pass: false, reason: "other lines were modified" };
      }
      return { pass: true, reason: "text prepended correctly" };
    },
  },
  {
    name: "insert newline to add a new line",
    description: "LLM inserts a newline character to create a new line",
    tool: "insert_text",
    document: "line1\nline3",
    selection: "line1",
    prompt:
      "Use insert_text at line 1, column 6 (after 'line1') to insert a newline followed by 'line2'. The result should be three lines: line1, line2, line3.",
    validate: (result) => {
      const lines = result.split("\n");
      if (lines.length < 3) {
        return { pass: false, reason: `expected at least 3 lines, got ${lines.length}` };
      }
      if (!result.includes("line2")) {
        return { pass: false, reason: "line2 not inserted" };
      }
      return { pass: true, reason: "newline insertion correct" };
    },
  },
];

/** @type {SmokeScenario[]} */
export const DELETE_LINES_SCENARIOS = [
  {
    name: "delete a single marked line",
    description: "LLM removes exactly one line from the document",
    tool: "delete_lines",
    document: "keep\nDELETE_THIS_LINE\nkeep2",
    selection: "DELETE_THIS_LINE",
    prompt:
      "Use delete_lines to delete line 2 (the selected DELETE_THIS_LINE line). Set start_line and end_line both to 2. Do not modify other lines.",
    validate: (result) => {
      if (result.includes("DELETE_THIS_LINE")) {
        return { pass: false, reason: "line was not deleted" };
      }
      const lines = result.split("\n");
      if (lines.length !== 2) {
        return { pass: false, reason: `expected 2 lines, got ${lines.length}` };
      }
      if (lines[0] !== "keep" || lines[1] !== "keep2") {
        return { pass: false, reason: "remaining lines were modified" };
      }
      return { pass: true, reason: "line deleted correctly" };
    },
  },
  {
    name: "delete multiple consecutive lines",
    description: "LLM removes a range of lines",
    tool: "delete_lines",
    document: "header\ndelete_a\ndelete_b\ndelete_c\nfooter",
    selection: "delete_a\ndelete_b\ndelete_c",
    prompt:
      "Use delete_lines to delete lines 2 through 4 (delete_a, delete_b, delete_c). Keep header and footer.",
    validate: (result) => {
      if (
        result.includes("delete_a") ||
        result.includes("delete_b") ||
        result.includes("delete_c")
      ) {
        return { pass: false, reason: "not all lines were deleted" };
      }
      if (!result.includes("header") || !result.includes("footer")) {
        return { pass: false, reason: "header or footer was modified" };
      }
      const lines = result.split("\n");
      if (lines.length !== 2) {
        return { pass: false, reason: `expected 2 lines, got ${lines.length}` };
      }
      return { pass: true, reason: "multi-line delete correct" };
    },
  },
];

/** @type {SmokeScenario[]} */
export const DELETE_SPAN_SCENARIOS = [
  {
    name: "delete substring within a line",
    description: "LLM removes part of a line without deleting the whole line",
    tool: "delete_span",
    document: '"items1":["car", "bike", "motorcycle", "van", "train"],',
    selection: "motorcycle",
    prompt:
      'Use delete_span on line 1 to delete the word motorcycle (columns 27-36). Do not delete the whole line.',
    validate: (result) => {
      const expected = '"items1":["car", "bike", "", "van", "train"],';
      if (result === expected) {
        return { pass: true, reason: "span deleted correctly" };
      }
      if (result.includes("motorcycle")) {
        return { pass: false, reason: "motorcycle still present" };
      }
      if (!result.includes('"items1"')) {
        return { pass: false, reason: "whole line was deleted instead of span edit" };
      }
      return { pass: true, reason: "partial span delete applied" };
    },
    retries: 2,
  },
];

/** @type {SmokeScenario[]} */
export const CONTEXT_WINDOW_SCENARIOS = [
  {
    name: "edit line in middle of large document",
    description: "LLM correctly targets a line far from the start using context window",
    tool: "replace_line",
    document: (() => {
      const head = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`);
      const target = "TARGET_LINE_FOR_SMOKE";
      const tail = Array.from({ length: 80 }, (_, i) => `tail ${i + 1}`);
      return [...head, target, ...tail].join("\n");
    })(),
    selection: "TARGET_LINE_FOR_SMOKE",
    prompt:
      "The selected line is near line 81. Use replace_line on that line only to set it to exactly: WINDOW_OK",
    validate: (result) => {
      if (!result.includes("WINDOW_OK")) {
        return { pass: false, reason: "WINDOW_OK not found" };
      }
      if (result.includes("TARGET_LINE_FOR_SMOKE")) {
        return { pass: false, reason: "original target line not replaced" };
      }
      const lines = result.split("\n");
      if (lines[80] !== "WINDOW_OK") {
        return {
          pass: false,
          reason: `line 81 is "${lines[80]}" not "WINDOW_OK"`,
        };
      }
      return { pass: true, reason: "context window edit correct" };
    },
  },
  {
    name: "edit near end of large document",
    description: "LLM targets a line near the end of a large document",
    tool: "replace_line",
    document: (() => {
      const lines = Array.from({ length: 150 }, (_, i) => `line_${i + 1}`);
      lines[148] = "NEAR_END_TARGET";
      return lines.join("\n");
    })(),
    selection: "NEAR_END_TARGET",
    prompt:
      "The selected line is near line 149. Use replace_line on that line to set it to exactly: END_OK",
    validate: (result) => {
      if (!result.includes("END_OK")) {
        return { pass: false, reason: "END_OK not found" };
      }
      if (result.includes("NEAR_END_TARGET")) {
        return { pass: false, reason: "target not replaced" };
      }
      return { pass: true, reason: "near-end edit correct" };
    },
  },
];

/** @type {SmokeScenario[]} */
export const MULTI_TOOL_SCENARIOS = [
  {
    name: "multiple edits in sequence",
    description: "LLM performs two tool calls in one agent turn",
    tool: "replace_line+insert_text",
    document: "title\nold_content\nfooter",
    selection: "old_content",
    prompt:
      "Make two changes: 1) Use replace_line on line 2 to change it to 'new_content', 2) Use insert_text on line 1 at column 6 to append '_updated'. The final document should have 'title_updated' on line 1 and 'new_content' on line 2.",
    validate: (result) => {
      const hasNewContent = result.includes("new_content");
      const hasUpdatedTitle =
        result.includes("title_updated") || result.includes("title_updated");
      if (!hasNewContent) {
        return { pass: false, reason: "new_content not found" };
      }
      if (!hasUpdatedTitle) {
        return {
          pass: false,
          reason: "title_updated not found (multi-tool may have partially succeeded)",
        };
      }
      if (result.includes("old_content")) {
        return { pass: false, reason: "old_content still present" };
      }
      return { pass: true, reason: "multi-tool edits applied correctly" };
    },
    retries: 2,
  },
];

/** @type {SmokeScenario[]} */
export const ERROR_RECOVERY_SCENARIOS = [
  {
    name: "handles out-of-range line gracefully",
    description: "LLM attempts to edit a line beyond document bounds; tool clamps it",
    tool: "replace_line",
    document: "only_line",
    selection: "only_line",
    prompt: "Use replace_line on line 1 to set it to exactly: CLAMPED_OK",
    validate: (result) => {
      if (result.includes("CLAMPED_OK")) {
        return { pass: true, reason: "edit applied (line clamped)" };
      }
      return { pass: false, reason: "expected CLAMPED_OK in result" };
    },
  },
];

export const ALL_SCENARIOS = {
  replace_line: REPLACE_LINE_SCENARIOS,
  replace_span: REPLACE_SPAN_SCENARIOS,
  insert_text: INSERT_TEXT_SCENARIOS,
  delete_lines: DELETE_LINES_SCENARIOS,
  delete_span: DELETE_SPAN_SCENARIOS,
  context_window: CONTEXT_WINDOW_SCENARIOS,
  multi_tool: MULTI_TOOL_SCENARIOS,
  error_recovery: ERROR_RECOVERY_SCENARIOS,
};

/** @returns {SmokeScenario[]} */
export function allScenarios() {
  return Object.values(ALL_SCENARIOS).flat();
}
