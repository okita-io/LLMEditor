// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Build OpenAI-compatible /v1/chat/completions bodies for LM Studio.
// Mirrors `apply_inference_settings` in src-tauri/src/llm_client.rs so
// smoke tests and unit tests exercise the same wire format as production.

/** @typedef {Record<string, unknown>} LmStudioSettings */

/** Defaults aligned with `Settings::default()` inference fields in Rust. */
export const LM_STUDIO_INFERENCE_DEFAULTS = Object.freeze({
  temperature: 0.2,
  max_tokens: 2048,
  system_prompt: "",
  limit_response_length: true,
  context_overflow_policy: "truncate_middle",
  stop_strings: "",
  top_k: 40,
  repeat_penalty_enabled: true,
  repeat_penalty: 1.1,
  presence_penalty_enabled: false,
  presence_penalty: 0,
  top_p_enabled: true,
  top_p: 0.95,
  min_p_enabled: true,
  min_p: 0.05,
  structured_output_enabled: false,
  structured_output: "",
});

/**
 * @param {string} policy
 * @returns {"truncateMiddle"|"rollingWindow"|"stopAtLimit"}
 */
export function contextOverflowPolicyApiValue(policy) {
  switch (policy) {
    case "rolling_window":
      return "rollingWindow";
    case "stop_at_limit":
      return "stopAtLimit";
    default:
      return "truncateMiddle";
  }
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
export function parseStopStrings(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
export function buildResponseFormat(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed && typeof parsed === "object" && parsed.json_schema) {
    return parsed;
  }
  if (parsed && typeof parsed === "object" && parsed.type === "json_schema") {
    return parsed;
  }

  return {
    type: "json_schema",
    json_schema: {
      name: "structured_output",
      strict: true,
      schema: parsed,
    },
  };
}

/**
 * Append LM Studio inference parameters to a chat-completions body object.
 *
 * LM Studio-specific knobs live under the `lmstudio` extension object on
 * POST /v1/chat/completions. HTTP keys use snake_case (e.g.
 * `context_overflow_policy`); enum values use camelCase strings
 * (`truncateMiddle`, …) per lmstudio-js shared types.
 *
 * `min_p` is not listed on the OpenAI-compat docs page but is honored by
 * LM Studio's v1 server in practice — treat as best-effort.
 *
 * `context_overflow_policy` is kept in settings for the UI but omitted from
 * the request body because LM Studio's HTTP API currently rejects every
 * `lmstudio.context_overflow_policy` value with HTTP 400 (bug #532).
 *
 * @param {Record<string, unknown>} body
 * @param {LmStudioSettings} settings
 */
export function applyInferenceSettings(body, settings) {
  const s = { ...LM_STUDIO_INFERENCE_DEFAULTS, ...(settings || {}) };

  if (s.limit_response_length !== false) {
    body.max_tokens = s.max_tokens;
  }

  const stops = parseStopStrings(String(s.stop_strings ?? ""));
  if (stops.length > 0) {
    body.stop = stops;
  }

  const topK = Number(s.top_k);
  if (Number.isFinite(topK) && topK > 0) {
    body.top_k = topK;
  }

  if (s.repeat_penalty_enabled !== false) {
    body.repeat_penalty = s.repeat_penalty;
  }

  if (s.presence_penalty_enabled === true) {
    body.presence_penalty = s.presence_penalty;
  }

  if (s.top_p_enabled !== false) {
    body.top_p = s.top_p;
  }

  if (s.min_p_enabled !== false) {
    body.min_p = s.min_p;
  }

  if (s.structured_output_enabled === true) {
    const responseFormat = buildResponseFormat(String(s.structured_output ?? ""));
    if (responseFormat) {
      body.response_format = responseFormat;
    }
  }
}

/**
 * @param {LmStudioSettings} settings
 * @param {Array<Record<string, unknown>>} messages
 * @param {{ stream?: boolean, tools?: unknown[] | null }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildLmStudioChatBody(settings, messages, options = {}) {
  const s = { ...(settings || {}) };
  const body = {
    model: s.model,
    messages,
    temperature: s.temperature ?? LM_STUDIO_INFERENCE_DEFAULTS.temperature,
    stream: options.stream === true,
  };

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools;
  }

  applyInferenceSettings(body, s);
  return body;
}

/**
 * @param {LmStudioSettings} [overrides]
 * @returns {LmStudioSettings}
 */
export function defaultLmStudioSettings(overrides = {}) {
  return {
    api_url: "http://localhost:1234/v1/chat/completions",
    model: "local-model",
    replace_mode: "replace_document",
    tab_spaces: 4,
    ...LM_STUDIO_INFERENCE_DEFAULTS,
    ...overrides,
  };
}
