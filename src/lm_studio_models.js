// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LM Studio model listing (/api/v1/models, with /v1/models fallback).

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Derive the LM Studio server base URL from a chat-completions endpoint.
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function lmStudioBaseUrl(apiUrl) {
  const trimmed =
    typeof apiUrl === "string" ? apiUrl.trim().replace(/\/+$/, "") : "";
  if (trimmed.endsWith("/api/v1/chat/completions")) {
    return trimmed.slice(0, -"/api/v1/chat/completions".length);
  }
  if (trimmed.endsWith("/v1/chat/completions")) {
    return trimmed.slice(0, -"/v1/chat/completions".length);
  }
  if (trimmed.endsWith("/api/v1")) {
    return trimmed.slice(0, -"/api/v1".length);
  }
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -"/v1".length);
  }
  return trimmed;
}

/**
 * Build the LM Studio models list URL from a chat-completions endpoint.
 * LM Studio's native REST API uses `/api/v1/models`.
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function lmStudioModelsUrl(apiUrl) {
  const trimmed =
    typeof apiUrl === "string" ? apiUrl.trim().replace(/\/+$/, "") : "";
  if (trimmed.length === 0) return "";

  if (trimmed.endsWith("/api/v1/models")) {
    return trimmed;
  }

  try {
    return `${new URL(trimmed).origin}/api/v1/models`;
  } catch {
    const base = lmStudioBaseUrl(trimmed);
    return base.length > 0 ? `${base}/api/v1/models` : "";
  }
}

/**
 * Legacy OpenAI-compatible models URL on some LM Studio versions.
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function lmStudioLegacyModelsUrl(apiUrl) {
  const base = lmStudioBaseUrl(apiUrl);
  return base.length > 0 ? `${base}/v1/models` : "";
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      fetch(url, { method: "GET", headers: { Accept: "application/json" } }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`request timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {Response} res
 * @returns {Promise<string[]>}
 */
async function parseModelsResponse(res) {
  if (!res.ok) {
    throw new Error(`models request failed: HTTP ${res.status}`);
  }

  const body = await res.json();
  // Support both OpenAI-compatible format ({ data: [...] }) and
  // LM Studio's native REST format ({ models: [...] }).
  const entries = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : [];
  /** @type {string[]} */
  const ids = [];
  const seen = new Set();

  for (const entry of entries) {
    const id =
      entry && typeof entry === "object" && typeof entry.id === "string"
        ? entry.id.trim()
        : entry && typeof entry === "object" && typeof entry.key === "string"
          ? entry.key.trim()
          : "";
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  if (ids.length === 0) {
    throw new Error("server returned no models (load a model in LM Studio first)");
  }

  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}

/**
 * Fetch model ids from an LM Studio (or compatible) server.
 *
 * @param {string} apiUrl Chat completions URL or server base URL.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function fetchLmStudioModels(apiUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const primaryUrl = lmStudioModelsUrl(apiUrl);
  if (primaryUrl.length === 0) {
    throw new Error("API URL is required");
  }

  const legacyUrl = lmStudioLegacyModelsUrl(apiUrl);
  // Prefer the OpenAI-compatible /v1/models endpoint first — it only
  // returns loaded models. The native /api/v1/models endpoint returns
  // all downloaded models (including unloaded ones), which causes
  // "model not found" errors at inference time.
  let res;
  if (legacyUrl && legacyUrl !== primaryUrl) {
    try {
      res = await fetchWithTimeout(legacyUrl, timeoutMs);
      if (res.ok) return parseModelsResponse(res);
    } catch {
      // Fall through to primary
    }
  }
  res = await fetchWithTimeout(primaryUrl, timeoutMs);
  return parseModelsResponse(res);
}

/**
 * @typedef {Object} LmStudioReasoningCapability
 * @property {string[]} allowed_options
 * @property {string | null} default
 *
 * @typedef {Object} LmStudioModelCapabilities
 * @property {boolean} vision
 * @property {boolean} tool_use
 * @property {LmStudioReasoningCapability | null} reasoning
 *
 * @typedef {Object} LmStudioModelInfo
 * @property {string} id
 * @property {boolean} loaded
 * @property {LmStudioModelCapabilities} capabilities
 */

/**
 * Empty capability shape used as the fallback for endpoints that don't
 * surface per-model metadata (older LM Studio builds, OpenAI-compat-only
 * servers).
 *
 * @returns {LmStudioModelCapabilities}
 */
export function emptyCapabilities() {
  return { vision: false, tool_use: false, reasoning: null };
}

/**
 * Normalize a single entry from `/api/v1/models` (or the legacy
 * `/v1/models`) into the shared `LmStudioModelInfo` shape. Embedding
 * models return `null` so callers can drop them from the chat picker
 * without re-checking the model `type` field.
 *
 * @param {unknown} entry
 * @returns {LmStudioModelInfo | null}
 */
export function parseModelInfoEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const rawId =
    typeof entry.id === "string"
      ? entry.id
      : typeof entry.key === "string"
        ? entry.key
        : "";
  const id = rawId.trim();
  if (id.length === 0) return null;

  const type =
    typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  if (type === "embedding" || type === "embeddings") return null;

  let loaded = false;
  if (Array.isArray(entry.loaded_instances)) {
    loaded = entry.loaded_instances.length > 0;
  } else if (typeof entry.state === "string") {
    loaded = entry.state === "loaded";
  }

  const caps =
    entry.capabilities && typeof entry.capabilities === "object"
      ? entry.capabilities
      : null;

  let vision = false;
  let toolUse = false;
  /** @type {LmStudioReasoningCapability | null} */
  let reasoning = null;

  if (caps && !Array.isArray(caps)) {
    vision = caps.vision === true;
    toolUse = caps.trained_for_tool_use === true;
    const r = caps.reasoning;
    if (r && typeof r === "object" && Array.isArray(r.allowed_options)) {
      const allowed = r.allowed_options
        .filter((opt) => typeof opt === "string" && opt.length > 0);
      if (allowed.length > 0) {
        reasoning = {
          allowed_options: allowed,
          default: typeof r.default === "string" ? r.default : null,
        };
      }
    }
  } else if (Array.isArray(caps)) {
    toolUse = caps.includes("tool_use");
  }

  return {
    id,
    loaded,
    capabilities: { vision, tool_use: toolUse, reasoning },
  };
}

/**
 * @param {Response} res
 * @returns {Promise<LmStudioModelInfo[]>}
 */
async function parseDetailedModelsResponse(res) {
  if (!res.ok) {
    throw new Error(`models request failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const entries = Array.isArray(body?.models)
    ? body.models
    : Array.isArray(body?.data)
      ? body.data
      : [];
  /** @type {LmStudioModelInfo[]} */
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const info = parseModelInfoEntry(entry);
    if (info === null || seen.has(info.id)) continue;
    seen.add(info.id);
    out.push(info);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Fetch models with capability metadata. Always hits LM Studio's native
 * `/api/v1/models` endpoint because the OpenAI-compatible one does not
 * surface `capabilities`.
 *
 * @param {string} apiUrl
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<LmStudioModelInfo[]>}
 */
export async function fetchLmStudioModelsDetailed(apiUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nativeUrl = lmStudioModelsUrl(apiUrl);
  if (nativeUrl.length === 0) {
    throw new Error("API URL is required");
  }
  const res = await fetchWithTimeout(nativeUrl, timeoutMs);
  return parseDetailedModelsResponse(res);
}
