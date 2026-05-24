// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Live LM Studio HTTP client for smoke tests (no Tauri required).

import { editorToolDefinitions } from "../../../editor_tool_schemas.js";
import { fetchLmStudioModels, lmStudioBaseUrl, lmStudioModelsUrl } from "../../../lm_studio_models.js";

const DEFAULT_API_URL = "http://10.0.1.2:1234/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 120_000;

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
 * @param {ReturnType<typeof getSmokeConfig>} config
 * @returns {Promise<{ content: string|null, tool_calls: Array<{ id: string, name: string, arguments: string }>, finish_reason: string|null }>}
 */
export async function liveAgentTurn(messages, config) {
  const model = await resolveSmokeModel(config.apiUrl, config.model);
  try {
    const res = await fetchWithTimeout(
      config.apiUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          stream: false,
          tools: editorToolDefinitions(),
        }),
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
 * Install a Tauri IPC stub that forwards agent_turn to live LM Studio.
 *
 * @param {ReturnType<typeof getSmokeConfig>} config
 * @returns {Promise<{ settings: object, model: string }>}
 */
export async function installLmStudioBridge(config) {
  const model = await resolveSmokeModel(config.apiUrl, config.model);
  const settings = {
    api_url: config.apiUrl,
    model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    replace_mode: "replace_document",
    system_prompt: "",
  };

  globalThis.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (cmd === "agent_turn") {
          return liveAgentTurn(args.messages, config);
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
