// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Build the outgoing LM Studio request preview for the agent loop.
// Mirrors `build_agent_body` in src-tauri/src/llm_client.rs.

import {
  buildLmStudioChatBody,
  LM_STUDIO_INFERENCE_DEFAULTS,
} from "./lm_studio_inference.js";

/**
 * @param {object} settings
 * @param {Array<Record<string, unknown>>} messages
 * @param {Array<Record<string, unknown>>} [agentTools] — default + user tools
 * @returns {Record<string, unknown>}
 */
export function buildAgentRequestPreview(settings, messages, agentTools = []) {
  return buildLmStudioChatBody(settings, messages, {
    stream: false,
    tools: agentTools,
  });
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
