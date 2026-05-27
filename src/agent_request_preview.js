// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Build the outgoing LM Studio request preview for the agent loop.
// Mirrors `build_agent_body` in src-tauri/src/llm_client.rs.

import {
  buildLmStudioChatBody,
  LM_STUDIO_INFERENCE_DEFAULTS,
} from "./lm_studio_inference.js";

/** Tool schemas attached to every agent turn (mirrors editor_tools.rs). */
export const AGENT_TOOL_DEFINITIONS = Object.freeze([
  {
    type: "function",
    function: {
      name: "get_document",
      description:
        "Return the document with 1-based line numbers. For large files this returns the same context window shown in the user message (lines before/after the selection); line numbers are absolute in the full file. Selected lines are marked with >>.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
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
      name: "replace_line",
      description:
        "Replace the entire content of a single line. text is the full new line content (not a substring). If text contains newlines, the line expands into multiple lines.",
      parameters: {
        type: "object",
        properties: {
          line: { type: "integer", description: "1-based line number" },
          text: {
            type: "string",
            description: "Complete replacement content for the line",
          },
        },
        required: ["line", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_span",
      description:
        "Replace a character span within a single line. Use this to change part of a line without rewriting the whole line. Columns are 1-based and inclusive. Columns past the line end extend to end-of-line (like a text editor selection).",
      parameters: {
        type: "object",
        properties: {
          line: { type: "integer", description: "1-based line number" },
          start_column: {
            type: "integer",
            description: "First column to replace (1-based, inclusive)",
          },
          end_column: {
            type: "integer",
            description: "Last column to replace (1-based, inclusive)",
          },
          text: { type: "string", description: "Replacement text for the span" },
        },
        required: ["line", "start_column", "end_column", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_lines",
      description:
        "Delete one or more entire lines. start_line and end_line are 1-based and inclusive. To delete a single line, set both to that line number.",
      parameters: {
        type: "object",
        properties: {
          start_line: { type: "integer", description: "First line to delete (1-based)" },
          end_line: {
            type: "integer",
            description: "Last line to delete (1-based, inclusive)",
          },
        },
        required: ["start_line", "end_line"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_span",
      description:
        "Delete a character span within a single line. Use this to remove part of a line without deleting the whole line. Columns are 1-based and inclusive. Columns past the line end extend to end-of-line (like a text editor selection).",
      parameters: {
        type: "object",
        properties: {
          line: { type: "integer", description: "1-based line number" },
          start_column: {
            type: "integer",
            description: "First column to delete (1-based, inclusive)",
          },
          end_column: {
            type: "integer",
            description: "Last column to delete (1-based, inclusive)",
          },
        },
        required: ["line", "start_column", "end_column"],
        additionalProperties: false,
      },
    },
  },
]);

/**
 * @param {object} settings
 * @param {Array<Record<string, unknown>>} messages
 * @param {Array<Record<string, unknown>>} [extraTools]  — custom tools to append
 * @returns {Record<string, unknown>}
 */
export function buildAgentRequestPreview(settings, messages, extraTools = []) {
  const tools =
    extraTools.length > 0
      ? [...AGENT_TOOL_DEFINITIONS, ...extraTools]
      : [...AGENT_TOOL_DEFINITIONS];
  return buildLmStudioChatBody(settings, messages, { stream: false, tools });
}

/**
 * @param {object} settings
 * @returns {string}
 */
export function formatInferenceSettingsSummary(settings) {
  const s = { ...LM_STUDIO_INFERENCE_DEFAULTS, ...(settings || {}) };
  const lines = [
    `API URL: ${s.api_url ?? "(default)"}`,
    `Model: ${s.model ?? "(none)"}`,
    `Temperature: ${s.temperature ?? LM_STUDIO_INFERENCE_DEFAULTS.temperature}`,
    `Reasoning: ${s.reasoning_enabled === false ? "off (reasoning_effort: minimal)" : "on (model default)"}`,
  ];

  if (s.limit_response_length !== false) {
    lines.push(`Max tokens: ${s.max_tokens ?? LM_STUDIO_INFERENCE_DEFAULTS.max_tokens}`);
  } else {
    lines.push("Max tokens: (unlimited)");
  }

  if (typeof s.stop_strings === "string" && s.stop_strings.trim().length > 0) {
    lines.push(`Stop strings: ${s.stop_strings.trim()}`);
  }

  const topK = Number(s.top_k);
  if (Number.isFinite(topK) && topK > 0) {
    lines.push(`Top K: ${topK}`);
  }

  if (s.repeat_penalty_enabled !== false) {
    lines.push(`Repeat penalty: ${s.repeat_penalty ?? LM_STUDIO_INFERENCE_DEFAULTS.repeat_penalty}`);
  }

  if (s.presence_penalty_enabled === true) {
    lines.push(`Presence penalty: ${s.presence_penalty ?? 0}`);
  }

  if (s.top_p_enabled !== false) {
    lines.push(`Top P: ${s.top_p ?? LM_STUDIO_INFERENCE_DEFAULTS.top_p}`);
  }

  if (s.min_p_enabled !== false) {
    lines.push(`Min P: ${s.min_p ?? LM_STUDIO_INFERENCE_DEFAULTS.min_p}`);
  }

  if (s.structured_output_enabled === true) {
    lines.push("Structured output: enabled");
  }

  lines.push(
    `Context overflow policy: ${s.context_overflow_policy ?? LM_STUDIO_INFERENCE_DEFAULTS.context_overflow_policy} (omitted on wire — LM Studio #532)`
  );

  return lines.join("\n");
}

/**
 * @param {Array<{ role: string, content: string }>} priorTurns
 * @returns {string}
 */
export function formatPriorTurnsForLog(priorTurns) {
  if (!Array.isArray(priorTurns) || priorTurns.length === 0) {
    return "(none — first message in session)";
  }
  return priorTurns
    .map((turn, index) => {
      const role = typeof turn.role === "string" ? turn.role : "unknown";
      const content = typeof turn.content === "string" ? turn.content : "";
      return `[${index + 1}] ${role}:\n${content}`;
    })
    .join("\n\n");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stringifyRequestBody(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
