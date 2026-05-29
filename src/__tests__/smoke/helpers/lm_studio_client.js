// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Live LM Studio HTTP client for smoke tests (no Tauri required).

import { editorToolDefinitions } from "../../../editor_tool_schemas.js";
import {
  buildLmStudioChatBody,
  defaultLmStudioSettings,
} from "../../../lm_studio_inference.js";
import { fetchLmStudioModels, lmStudioBaseUrl, lmStudioModelsUrl } from "../../../lm_studio_models.js";

const DEFAULT_API_URL = "http://10.0.1.2:1234/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 120_000;

/** @type {Record<string, unknown> | null} */
let lastRequestBody = null;

/**
 * @returns {Record<string, unknown> | null}
 */
export function getLastRequestBody() {
  return lastRequestBody;
}

/**
 * @returns {void}
 */
export function clearLastRequestBody() {
  lastRequestBody = null;
}

/**
 * @returns {{
 *   enabled: boolean,
 *   apiUrl: string,
 *   model: string | null,
 *   temperature: number,
 *   maxTokens: number,
 *   timeoutMs: number,
 * }}
 */
export function getSmokeConfig() {
  return {
    enabled: process.env.LLM_SMOKE === "1",
    apiUrl: process.env.LLM_API_URL || DEFAULT_API_URL,
    model: process.env.LLM_MODEL || null,
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.1"),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? "2048"),
    timeoutMs: Number(process.env.LLM_SMOKE_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS)),
  };
}

/**
 * @param {string} apiUrl
 * @returns {string}
 */
export { lmStudioBaseUrl, lmStudioModelsUrl };

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      fetch(url, init),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fetch timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {string} apiUrl
 * @returns {Promise<boolean>}
 */
export async function pingLmStudio(apiUrl) {
  try {
    const models = await fetchLmStudioModels(apiUrl);
    return models.length > 0;
  } catch {
    return false;
  }
}

/**
 * @param {string} apiUrl
 * @param {string | null} preferredModel
 * @returns {Promise<string>}
 */
export async function resolveSmokeModel(apiUrl, preferredModel) {
  if (typeof preferredModel === "string" && preferredModel.length > 0) {
    return preferredModel;
  }
  const models = await fetchLmStudioModels(apiUrl);
  return models[0];
}

/**
 * @param {Array<Record<string, unknown>>} messages
 * @param {Record<string, unknown>} settings
 * @param {ReturnType<typeof getSmokeConfig>} config
 * @returns {Promise<{ content: string|null, tool_calls: Array<{ id: string, name: string, arguments: string }>, finish_reason: string|null }>}
 */
export async function liveAgentTurn(messages, settings, config) {
  const model =
    typeof settings.model === "string" && settings.model.length > 0
      ? settings.model
      : await resolveSmokeModel(config.apiUrl, config.model);

  const mergedSettings = { ...settings, model, api_url: config.apiUrl };
  const body = buildLmStudioChatBody(mergedSettings, messages, {
    stream: false,
    tools: editorToolDefinitions(),
  });
  lastRequestBody = body;

  try {
    const res = await fetchWithTimeout(
      config.apiUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      config.timeoutMs
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`agent turn failed: HTTP ${res.status} ${detail}`.trim());
    }
    const envelope = await res.json();
    return parseAgentTurnResponse(envelope);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * @param {unknown} envelope
 * @returns {{ content: string|null, tool_calls: Array<{ id: string, name: string, arguments: string }>, finish_reason: string|null }}
 */
export function parseAgentTurnResponse(envelope) {
  const choice =
    envelope &&
    typeof envelope === "object" &&
    Array.isArray(envelope.choices) &&
    envelope.choices[0];
  if (!choice || typeof choice !== "object") {
    throw new Error("invalid LM Studio response: missing choices[0]");
  }
  const message = choice.message;
  if (!message || typeof message !== "object") {
    throw new Error("invalid LM Studio response: missing message");
  }

  let content = null;
  if (typeof message.content === "string" && message.content.length > 0) {
    content = message.content;
  }

  /** @type {Array<{ id: string, name: string, arguments: string }>} */
  const tool_calls = [];
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const id = typeof tc.id === "string" ? tc.id : "";
      const fn = tc.function;
      if (!fn || typeof fn !== "object") continue;
      const name = typeof fn.name === "string" ? fn.name : "";
      const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
      if (id.length > 0 && name.length > 0) {
        tool_calls.push({ id, name, arguments: args });
      }
    }
  }

  const finish_reason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : null;

  return { content, tool_calls, finish_reason };
}

/**
 * Dispatch an `editor:reasoning-stream-token` DOM event carrying a single
 * reasoning fragment. Mirrors the production bridge in `main.js`, which
 * forwards the backend's `tauri://llm-reasoning-token` events onto the same
 * DOM channel the chat panel listens on. No-op outside a DOM environment.
 *
 * @param {string} fragment
 * @returns {void}
 */
function emitReasoningToken(fragment) {
  if (typeof fragment !== "string" || fragment.length === 0) return;
  if (typeof document === "undefined" || typeof CustomEvent !== "function") {
    return;
  }
  document.dispatchEvent(
    new CustomEvent("editor:reasoning-stream-token", {
      detail: { fragment },
    })
  );
}

/**
 * Accumulate a single streamed SSE delta object into the in-progress turn
 * and emit any reasoning fragments. Mirrors the Rust `agent_stream` parser
 * in `src-tauri/src/llm_client.rs`: reasoning arrives on `delta.reasoning`
 * or `delta.reasoning_content`, assistant text on `delta.content`, and tool
 * calls on `delta.tool_calls` (indexed, with incremental argument strings).
 *
 * @param {{ content: string, reasoning: string, toolCalls: Map<number, { id: string, name: string, arguments: string }>, finishReason: string|null }} acc
 * @param {Record<string, unknown>} chunk
 * @returns {void}
 */
function pushStreamChunk(acc, chunk) {
  const choice =
    chunk && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice || typeof choice !== "object") return;

  if (typeof choice.finish_reason === "string") {
    acc.finishReason = choice.finish_reason;
  }

  const delta = choice.delta;
  if (!delta || typeof delta !== "object") return;

  for (const field of [delta.reasoning, delta.reasoning_content]) {
    if (typeof field === "string" && field.length > 0) {
      acc.reasoning += field;
      emitReasoningToken(field);
    }
  }

  if (typeof delta.content === "string" && delta.content.length > 0) {
    acc.content += delta.content;
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const index = Number.isInteger(tc.index) ? tc.index : 0;
      const entry =
        acc.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof tc.id === "string" && tc.id.length > 0) entry.id = tc.id;
      const fn = tc.function;
      if (fn && typeof fn === "object") {
        if (typeof fn.name === "string" && fn.name.length > 0) {
          entry.name = fn.name;
        }
        if (typeof fn.arguments === "string") {
          entry.arguments += fn.arguments;
        }
      }
      acc.toolCalls.set(index, entry);
    }
  }
}

/**
 * Streaming variant of {@link liveAgentTurn}. POSTs with `stream: true`,
 * parses the Server-Sent Events response, emits `editor:reasoning-stream-token`
 * DOM events as reasoning fragments arrive, and resolves with the assembled
 * turn (including the aggregated `reasoning` string). Faithful to the
 * production path in `src-tauri/src/llm_client.rs::agent_turn_streaming`.
 *
 * @param {Array<Record<string, unknown>>} messages
 * @param {Record<string, unknown>} settings
 * @param {ReturnType<typeof getSmokeConfig>} config
 * @returns {Promise<{ content: string|null, tool_calls: Array<{ id: string, name: string, arguments: string }>, finish_reason: string|null, reasoning: string|null }>}
 */
export async function liveAgentTurnStreaming(messages, settings, config) {
  const model =
    typeof settings.model === "string" && settings.model.length > 0
      ? settings.model
      : await resolveSmokeModel(config.apiUrl, config.model);

  const mergedSettings = { ...settings, model, api_url: config.apiUrl };
  const body = buildLmStudioChatBody(mergedSettings, messages, {
    stream: true,
    tools: editorToolDefinitions(),
  });
  lastRequestBody = body;

  const res = await fetchWithTimeout(
    config.apiUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    config.timeoutMs
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`agent turn failed: HTTP ${res.status} ${detail}`.trim());
  }
  if (!res.body || typeof res.body.getReader !== "function") {
    throw new Error("streaming response body is not readable");
  }

  const acc = {
    content: "",
    reasoning: "",
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    toolCalls: new Map(),
    /** @type {string|null} */
    finishReason: null,
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  while (!done) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const record = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const payload = extractSsePayload(record);
      if (payload === null) continue;
      if (payload === "[DONE]") {
        done = true;
        break;
      }
      try {
        pushStreamChunk(acc, JSON.parse(payload));
      } catch {
        // Ignore malformed keep-alive or partial records.
      }
    }
  }

  // Flush any trailing buffered record (some servers omit the final blank line).
  const tail = extractSsePayload(buffer);
  if (tail !== null && tail !== "[DONE]") {
    try {
      pushStreamChunk(acc, JSON.parse(tail));
    } catch {
      /* ignore */
    }
  }

  return {
    content: acc.content.length > 0 ? acc.content : null,
    tool_calls: [...acc.toolCalls.values()].filter(
      (tc) => tc.id.length > 0 && tc.name.length > 0
    ),
    finish_reason: acc.finishReason,
    reasoning: acc.reasoning.length > 0 ? acc.reasoning : null,
  };
}

/**
 * Extract the `data:` payload from a single SSE record, or `null` when the
 * record is a comment/keep-alive or carries no data line.
 *
 * @param {string} record
 * @returns {string|null}
 */
function extractSsePayload(record) {
  const trimmed = record.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("data:")) return null;
  return trimmed.slice("data:".length).trimStart();
}

/**
 * POST a simple chat completion (no tools) and return assistant text.
 *
 * @param {Array<Record<string, unknown>>} messages
 * @param {Record<string, unknown>} settings
 * @param {ReturnType<typeof getSmokeConfig>} config
 * @returns {Promise<string|null>}
 */
export async function liveSimpleCompletion(messages, settings, config) {
  const model =
    typeof settings.model === "string" && settings.model.length > 0
      ? settings.model
      : await resolveSmokeModel(config.apiUrl, config.model);

  const mergedSettings = { ...settings, model, api_url: config.apiUrl };
  const body = buildLmStudioChatBody(mergedSettings, messages, { stream: false });
  lastRequestBody = body;

  const res = await fetchWithTimeout(
    config.apiUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    config.timeoutMs
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`completion failed: HTTP ${res.status} ${detail}`.trim());
  }
  const envelope = await res.json();
  return parseAgentTurnResponse(envelope).content;
}

/**
 * Install a Tauri IPC stub that forwards agent_turn to live LM Studio.
 *
 * When `options.stream` is true the bridge routes `agent_turn` through
 * {@link liveAgentTurnStreaming}, which parses the SSE response and emits
 * `editor:reasoning-stream-token` DOM events as reasoning fragments arrive —
 * faithful to the production `tauri://llm-reasoning-token` bridge in
 * `main.js`. Otherwise it uses the non-streaming {@link liveAgentTurn}.
 *
 * @param {ReturnType<typeof getSmokeConfig>} config
 * @param {{ settings?: Record<string, unknown>, stream?: boolean }} [options]
 * @returns {Promise<{ settings: object, model: string }>}
 */
export async function installLmStudioBridge(config, options = {}) {
  clearLastRequestBody();
  const model = await resolveSmokeModel(config.apiUrl, config.model);
  const settings = defaultLmStudioSettings({
    api_url: config.apiUrl,
    model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    ...(options.settings || {}),
  });
  const streaming = options.stream === true;

  globalThis.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (cmd === "agent_turn") {
          const turnSettings =
            args && typeof args.settings === "object"
              ? { ...settings, ...args.settings }
              : settings;
          return streaming
            ? liveAgentTurnStreaming(args.messages, turnSettings, config)
            : liveAgentTurn(args.messages, turnSettings, config);
        }
        if (cmd === "load_settings") {
          return settings;
        }
        if (cmd === "stream_llm" || cmd === "call_llm") {
          throw new Error(`${cmd} is not used in smoke tests`);
        }
        if (cmd === "cancel_stream") {
          return undefined;
        }
        throw new Error(`unexpected invoke in smoke test: ${cmd}`);
      },
    },
  };

  return { settings, model };
}
