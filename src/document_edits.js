// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Extract document edit intents from assistant chat text when the model
// describes JSON/tool payloads instead of calling tools.

/**
 * @typedef {{ name: string, args: Record<string, unknown>, source: string }} DocumentEdit
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  return null;
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {DocumentEdit | null}
 */
function normalizeToolObject(obj) {
  const toolName =
    typeof obj.tool === "string"
      ? obj.tool
      : typeof obj.name === "string" &&
          typeof obj.arguments === "object" &&
          obj.arguments !== null
        ? obj.name
        : null;

  if (toolName) {
    const args =
      toolName === obj.name && obj.arguments
        ? asObject(obj.arguments) ?? {}
        : { ...obj };
    delete args.tool;
    delete args.name;
    delete args.arguments;
    return { name: toolName, args, source: "tool-object" };
  }

  if (
    typeof obj.start_line !== "undefined" &&
    typeof obj.end_line !== "undefined" &&
    typeof obj.text === "string"
  ) {
    const startLine = obj.start_line;
    const endLine = obj.end_line;
    if (startLine === endLine) {
      return {
        name: "replace_line",
        args: {
          line: startLine,
          text: obj.text,
        },
        source: "replace_line-shape",
      };
    }
    return {
      name: "replace_range",
      args: {
        start_line: startLine,
        end_line: endLine,
        text: obj.text,
      },
      source: "replace_range-shape",
    };
  }

  if (
    typeof obj.line !== "undefined" &&
    typeof obj.start_column !== "undefined" &&
    typeof obj.end_column !== "undefined" &&
    typeof obj.text === "string"
  ) {
    return {
      name: "replace_span",
      args: {
        line: obj.line,
        start_column: obj.start_column,
        end_column: obj.end_column,
        text: obj.text,
      },
      source: "replace_span-shape",
    };
  }

  if (
    typeof obj.line !== "undefined" &&
    typeof obj.text === "string" &&
    typeof obj.column !== "undefined"
  ) {
    return {
      name: "insert_text",
      args: {
        line: obj.line,
        column: obj.column ?? 1,
        text: obj.text,
      },
      source: "insert_text-shape",
    };
  }

  if (
    typeof obj.line !== "undefined" &&
    typeof obj.text === "string" &&
    typeof obj.column === "undefined" &&
    typeof obj.start_column === "undefined"
  ) {
    return {
      name: "replace_line",
      args: {
        line: obj.line,
        text: obj.text,
      },
      source: "replace_line-shape",
    };
  }

  if (
    typeof obj.start_line !== "undefined" &&
    typeof obj.end_line !== "undefined" &&
    typeof obj.text === "undefined"
  ) {
    return {
      name: "delete_range",
      args: {
        start_line: obj.start_line,
        end_line: obj.end_line,
      },
      source: "delete_range-shape",
    };
  }

  return null;
}

/**
 * @param {unknown} parsed
 * @returns {DocumentEdit[]}
 */
function editsFromParsedJson(parsed) {
  /** @type {DocumentEdit[]} */
  const edits = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const obj = asObject(item);
      if (!obj) continue;
      if (obj.type === "function" && asObject(obj.function)) {
        const fn = asObject(obj.function);
        if (!fn || typeof fn.name !== "string") continue;
        let args = {};
        try {
          args =
            typeof fn.arguments === "string"
              ? JSON.parse(fn.arguments)
              : asObject(fn.arguments) ?? {};
        } catch {
          args = {};
        }
        edits.push({ name: fn.name, args, source: "tool-call-array" });
        continue;
      }
      const normalized = normalizeToolObject(obj);
      if (normalized) edits.push(normalized);
    }
    return edits;
  }

  const obj = asObject(parsed);
  if (!obj) return edits;

  if (Array.isArray(obj.tool_calls)) {
    return editsFromParsedJson(obj.tool_calls);
  }

  const normalized = normalizeToolObject(obj);
  if (normalized) edits.push(normalized);
  return edits;
}

/**
 * @param {string} block
 * @returns {DocumentEdit[]}
 */
function editsFromCodeBlock(block) {
  const trimmed = block.trim();
  if (trimmed.length === 0) return [];

  try {
    return editsFromParsedJson(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

/**
 * Extract editor tool operations embedded in assistant markdown/text.
 *
 * @param {string} text
 * @returns {DocumentEdit[]}
 */
export function extractDocumentEdits(text) {
  if (typeof text !== "string" || text.length === 0) return [];

  /** @type {DocumentEdit[]} */
  const edits = [];
  const seen = new Set();

  const fenceRe = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    for (const edit of editsFromCodeBlock(match[1])) {
      const key = `${edit.name}:${JSON.stringify(edit.args)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edits.push(edit);
    }
  }

  // Inline JSON objects mentioning tool names (single-line tool payloads).
  const inlineRes = [
    /\{\s*"tool"\s*:\s*"(insert_text|replace_line|replace_span|replace_range|delete_range|goto_line)"[\s\S]*?\}/g,
    /\{\s*"name"\s*:\s*"(insert_text|replace_line|replace_span|replace_range|delete_range|goto_line)"[\s\S]*?\}/g,
    /\{\s*"line"\s*:\s*\d+[\s\S]*?\}/g,
    /\{\s*"start_line"\s*:\s*\d+[\s\S]*?\}/g,
    /\{\s*"start_column"\s*:\s*\d+[\s\S]*?\}/g,
  ];
  for (const re of inlineRes) {
    re.lastIndex = 0;
    while ((match = re.exec(text)) !== null) {
      try {
        for (const edit of editsFromParsedJson(JSON.parse(match[0]))) {
          const key = `${edit.name}:${JSON.stringify(edit.args)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edits.push(edit);
        }
      } catch {
        /* ignore partial JSON in prose */
      }
    }
  }

  // Function-call style: insert_text({...})
  const callRe =
    /\b(insert_text|replace_line|replace_span|replace_range|delete_range|goto_line)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
  callRe.lastIndex = 0;
  while ((match = callRe.exec(text)) !== null) {
    try {
      for (const edit of editsFromParsedJson(JSON.parse(match[2]))) {
        const key = `${edit.name}:${JSON.stringify(edit.args)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edits.push({ ...edit, name: match[1], source: "function-call" });
      }
    } catch {
      /* ignore */
    }
  }

  return edits.filter((edit) =>
    [
      "insert_text",
      "replace_line",
      "replace_span",
      "replace_range",
      "delete_range",
      "goto_line",
    ].includes(edit.name)
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function assistantTextLooksLikeUnappliedEdits(text) {
  return extractDocumentEdits(text).some(
    (edit) =>
      edit.name === "insert_text" ||
      edit.name === "replace_line" ||
      edit.name === "replace_span" ||
      edit.name === "replace_range"
  );
}

export const _internal = {
  normalizeToolObject,
  editsFromParsedJson,
};
