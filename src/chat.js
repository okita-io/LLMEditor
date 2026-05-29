// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// AI chat panel — conversation UI separate from the document buffer.

import * as editor from "./editor.js";
import * as api from "./api.js";
import { clearHistory, getHistoryForAgent } from "./chat_history.js";
import { extractDocumentEdits } from "./document_edits.js";
import { stringifyRequestBody } from "./agent_request_preview.js";

let messagesEl = null;
let inputEl = null;
let sendBtn = null;
let clearBtn = null;
/** @type {HTMLSelectElement | null} */
let modelPickerEl = null;
/** @type {HTMLElement | null} */
let tokenCountEl = null;
/** @type {HTMLElement | null} */
let visionIconEl = null;
/** @type {HTMLElement | null} */
let toolsIconEl = null;
/** @type {HTMLButtonElement | null} */
let reasoningIconEl = null;
/** @type {string} */
let activeRequestModel = "";
/** @type {boolean} */
let modelListLoaded = false;
/** @type {boolean} */
let modelListLoading = false;
/** @type {HTMLElement | null} */
let activeAssistantBubble = null;
/** @type {HTMLElement | null} */
let activeAssistantBody = null;
/** @type {HTMLElement | null} */
let activeReasoningBubble = null;
/** @type {HTMLElement | null} */
let activeReasoningBody = null;
/** @type {number} */
let activeReasoningTurn = 0;
/** @type {HTMLElement | null} */
let pendingUserBubble = null;

/**
 * Capability metadata for every model the picker knows about, keyed by
 * the model id from the server. Populated by `loadModelList()` from
 * `api.listModelsDetailed`; missing entries fall back to the empty
 * capability shape so a server that only speaks OpenAI-compat still
 * renders the icons as muted rather than throwing.
 *
 * @type {Map<string, {
 *   loaded: boolean,
 *   capabilities: {
 *     vision: boolean,
 *     tool_use: boolean,
 *     reasoning: { allowed_options: string[], default: string | null } | null,
 *   },
 * }>}
 */
const modelCapabilityCache = new Map();

/**
 * Estimate the number of tokens in the chat history context.
 * Uses a rough approximation of ~4 characters per token.
 *
 * @returns {number}
 */
function estimateContextTokens() {
  const history = getHistoryForAgent();
  let totalChars = 0;
  for (const turn of history) {
    totalChars += turn.content.length;
  }
  return Math.round(totalChars / 4);
}

/**
 * Update the token count display element.
 *
 * @returns {void}
 */
function updateTokenCount() {
  if (!tokenCountEl) return;
  const tokens = estimateContextTokens();
  tokenCountEl.textContent = `${tokens.toLocaleString()} Tokens`;
}

/**
 * @returns {void}
 */
function scrollMessagesToBottom() {
  if (!messagesEl) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Lookup the cached capability metadata for `modelId`. Unknown models
 * resolve to the muted default shape so the icons render predictably
 * even before the detailed model list has loaded.
 *
 * @param {string} modelId
 * @returns {{
 *   vision: boolean,
 *   tool_use: boolean,
 *   reasoning: { allowed_options: string[], default: string | null } | null,
 * }}
 */
function capabilitiesFor(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return { vision: false, tool_use: false, reasoning: null };
  }
  const entry = modelCapabilityCache.get(modelId);
  if (!entry) return { vision: false, tool_use: false, reasoning: null };
  return entry.capabilities;
}

/**
 * Read the saved `reasoning_enabled` flag from settings (falling back
 * to true). Used to seed the reasoning icon's visual state on each
 * model-change so the toggle reflects what would actually be sent.
 *
 * @returns {Promise<boolean>}
 */
async function loadReasoningEnabled() {
  try {
    const s = await api.loadSettings();
    return s?.reasoning_enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Set the `data-state` attribute on a capability icon. CSS picks up the
 * attribute to paint success / muted colors.
 *
 * @param {HTMLElement | null} el
 * @param {"on"|"off"|"unsupported"|"forced-on"} state
 * @param {string} title
 */
function setIconState(el, state, title) {
  if (!el) return;
  el.dataset.state = state;
  el.title = title;
  if (el instanceof HTMLButtonElement) {
    el.setAttribute("aria-label", title);
    el.setAttribute("aria-pressed", state === "on" || state === "forced-on" ? "true" : "false");
  } else {
    el.setAttribute("aria-label", title);
  }
}

/**
 * Update the three capability icons in the send bar to reflect the
 * currently selected model. Also dispatches `model:capabilities-changed`
 * so the inference panel can gate its Reasoning checkbox on the same
 * source of truth.
 *
 * @param {string} modelId
 * @returns {Promise<void>}
 */
async function refreshCapabilityIcons(modelId) {
  const caps = capabilitiesFor(modelId);

  setIconState(
    visionIconEl,
    caps.vision ? "on" : "unsupported",
    caps.vision ? "Vision: supported" : "Vision: not supported"
  );
  setIconState(
    toolsIconEl,
    caps.tool_use ? "on" : "unsupported",
    caps.tool_use ? "Tool use: supported" : "Tool use: not supported"
  );

  if (reasoningIconEl) {
    const r = caps.reasoning;
    if (r === null) {
      reasoningIconEl.disabled = true;
      setIconState(reasoningIconEl, "unsupported", "Reasoning: not supported");
    } else if (!r.allowed_options.includes("off")) {
      reasoningIconEl.disabled = true;
      setIconState(reasoningIconEl, "forced-on", "Reasoning: always on (model default)");
    } else {
      const enabled = await loadReasoningEnabled();
      reasoningIconEl.disabled = false;
      setIconState(
        reasoningIconEl,
        enabled ? "on" : "off",
        enabled ? "Reasoning: on — click to disable" : "Reasoning: off — click to enable"
      );
    }
  }

  if (typeof document !== "undefined" && typeof CustomEvent === "function") {
    document.dispatchEvent(
      new CustomEvent("model:capabilities-changed", {
        detail: {
          model: modelId,
          vision: caps.vision,
          tool_use: caps.tool_use,
          reasoning: caps.reasoning,
        },
      })
    );
  }
}

/**
 * Toggle the persisted `reasoning_enabled` flag and refresh the icon.
 * No-op if the active model does not allow disabling reasoning.
 *
 * @returns {Promise<void>}
 */
async function onReasoningIconClick() {
  if (!reasoningIconEl || reasoningIconEl.disabled) return;
  const modelId = modelPickerEl?.value ?? "";
  const caps = capabilitiesFor(modelId);
  if (caps.reasoning === null || !caps.reasoning.allowed_options.includes("off")) {
    return;
  }
  let current;
  try {
    current = await api.loadSettings();
  } catch {
    current = {};
  }
  const next = current?.reasoning_enabled === false ? true : false;
  try {
    await api.saveSettings({ ...current, reasoning_enabled: next });
  } catch {
    /* keep visual state; persist failure is silent in the chat UI */
    return;
  }
  if (typeof document !== "undefined" && typeof CustomEvent === "function") {
    document.dispatchEvent(new CustomEvent("settings:inference-changed"));
  }
  await refreshCapabilityIcons(modelId);
}

/**
 * @param {"user"|"assistant"} role
 * @param {string} text
 * @returns {HTMLElement}
 */
function appendBubble(role, text) {
  if (!messagesEl) {
    const stub = document.createElement("div");
    return stub;
  }

  const bubble = document.createElement("div");
  bubble.className =
    role === "user" ? "chat-bubble chat-bubble-user" : "chat-bubble chat-bubble-assistant";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = role === "user" ? "You" : "Assistant";
  bubble.appendChild(label);

  const body = document.createElement("div");
  body.className = "chat-bubble-body";
  body.textContent = text;
  bubble.appendChild(body);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
  return body;
}

/**
 * @param {string} text
 * @returns {HTMLElement | null}
 */
function appendUserMessage(text) {
  if (!messagesEl) return null;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-user";
  bubble.dataset.chatText = text;

  const head = document.createElement("div");
  head.className = "chat-bubble-head";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = "You";
  head.appendChild(label);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "chat-retry-btn";
  retryBtn.hidden = true;
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", () => {
    void retryUserMessage(bubble);
  });
  head.appendChild(retryBtn);

  bubble.appendChild(head);

  const body = document.createElement("div");
  body.className = "chat-bubble-body";
  body.textContent = text;
  bubble.appendChild(body);

  const errorEl = document.createElement("div");
  errorEl.className = "chat-bubble-error";
  errorEl.hidden = true;
  bubble.appendChild(errorEl);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
  pendingUserBubble = bubble;
  return bubble;
}

/**
 * @param {HTMLElement} bubble
 * @returns {void}
 */
function clearUserBubbleFailure(bubble) {
  bubble.classList.remove("chat-bubble-failed");
  const retryBtn = bubble.querySelector(".chat-retry-btn");
  const errorEl = bubble.querySelector(".chat-bubble-error");
  if (retryBtn) retryBtn.hidden = true;
  if (errorEl) {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
}

/**
 * @param {string} [error]
 * @returns {void}
 */
function markPendingUserBubbleFailed(error) {
  if (!pendingUserBubble) return;
  pendingUserBubble.classList.add("chat-bubble-failed");
  const retryBtn = pendingUserBubble.querySelector(".chat-retry-btn");
  const errorEl = pendingUserBubble.querySelector(".chat-bubble-error");
  if (retryBtn) retryBtn.hidden = false;
  if (errorEl) {
    errorEl.textContent =
      typeof error === "string" && error.length > 0 ? error : "Request failed";
    errorEl.hidden = false;
  }
  scrollMessagesToBottom();
}

/**
 * @param {HTMLElement} bubble
 * @returns {Promise<void>}
 */
async function retryUserMessage(bubble) {
  const text = bubble.dataset.chatText;
  if (typeof text !== "string" || text.length === 0) return;
  pendingUserBubble = bubble;
  clearUserBubbleFailure(bubble);
  await editor.retryChatMessage(text);
}

/**
 * @param {boolean} streaming
 * @returns {void}
 */
function setStreamingUi(streaming) {
  if (inputEl) inputEl.disabled = streaming;
  if (sendBtn) sendBtn.disabled = streaming;
  if (modelPickerEl) {
    modelPickerEl.disabled = streaming;
    modelPickerEl.classList.toggle("streaming", streaming);
  }
}

/**
 * @param {string[]} modelIds
 * @param {string} [selectedModel]
 * @returns {void}
 */
function populateModelPicker(modelIds, selectedModel) {
  if (!modelPickerEl) return;

  const selected =
    typeof selectedModel === "string" && selectedModel.length > 0 ? selectedModel : "";
  const ids = Array.isArray(modelIds) ? modelIds.slice() : [];

  if (selected.length > 0 && !ids.includes(selected)) {
    ids.unshift(selected);
  }

  modelPickerEl.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(no model)";
  modelPickerEl.appendChild(placeholder);

  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    modelPickerEl.appendChild(opt);
  }

  modelPickerEl.value = selected.length > 0 && ids.includes(selected) ? selected : "";
}

/**
 * @returns {Promise<void>}
 */
async function loadModelList() {
  if (modelListLoaded || modelListLoading || !modelPickerEl) return;
  modelListLoading = true;

  try {
    const settings = await api.loadSettings();
    const currentModel =
      typeof settings?.model === "string" ? settings.model : modelPickerEl.value;

    // Prefer the detailed endpoint so we can populate capability icons.
    // If LM Studio is on an older build (no native endpoint) we fall back
    // to bare ids; the icons remain in their muted/unsupported state.
    let modelIds = [];
    try {
      const detailed = await api.listModelsDetailed(settings.api_url);
      modelCapabilityCache.clear();
      const loadedOnly = [];
      for (const m of detailed) {
        modelCapabilityCache.set(m.id, {
          loaded: m.loaded === true,
          capabilities: m.capabilities ?? {
            vision: false,
            tool_use: false,
            reasoning: null,
          },
        });
        if (m.loaded === true) loadedOnly.push(m.id);
      }
      // Loaded models are the only ones usable for inference; fall back
      // to the full set when nothing is loaded so the user can still see
      // what's downloaded.
      modelIds = loadedOnly.length > 0 ? loadedOnly : detailed.map((m) => m.id);
    } catch {
      modelIds = await api.listModels(settings.api_url);
    }
    populateModelPicker(modelIds, currentModel);
    modelListLoaded = true;
    await refreshCapabilityIcons(modelPickerEl.value);
  } catch {
    const current = modelPickerEl.value;
    if (current.length > 0) {
      populateModelPicker([current], current);
    }
    await refreshCapabilityIcons(modelPickerEl?.value ?? "");
  } finally {
    modelListLoading = false;
  }
}

/**
 * @returns {Promise<void>}
 */
async function onModelPickerChange() {
  if (!modelPickerEl) return;

  const model = modelPickerEl.value;
  try {
    const settings = await api.loadSettings();
    await api.saveSettings({ ...settings, model });
    if (typeof document !== "undefined" && typeof CustomEvent === "function") {
      document.dispatchEvent(
        new CustomEvent("settings:model-changed", {
          detail: { model },
        })
      );
    }
  } catch {
    /* keep picker value; save failure is silent in chat UI */
  }
  await refreshCapabilityIcons(model);
}

/**
 * @param {string} model
 * @returns {void}
 */
export function setModelName(model) {
  if (!modelPickerEl) return;
  const name = typeof model === "string" && model.length > 0 ? model : "";
  if (name.length > 0) {
    populateModelPicker([name], name);
  } else {
    populateModelPicker([], "");
  }
}

/**
 * @returns {void}
 */
export function clearMessages() {
  if (messagesEl) messagesEl.replaceChildren();
  activeAssistantBody = null;
  activeAssistantBubble = null;
  activeReasoningBody = null;
  activeReasoningBubble = null;
  activeReasoningTurn = 0;
  pendingUserBubble = null;
  clearHistory();
  updateTokenCount();
}

/**
 * @param {string} text
 * @returns {void}
 */
export function addUserMessage(text) {
  appendUserMessage(text);
}

/**
 * @param {string} raw
 * @returns {string}
 */
function prettyJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "{}";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Compact JSON for a single-line tool invocation (preserves invalid JSON as-is).
 *
 * @param {string} raw
 * @returns {string}
 */
function compactJsonForInvocation(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "{}";
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

/**
 * @param {string} name
 * @param {string} argsJson
 * @returns {string}
 */
export function formatToolInvocation(name, argsJson) {
  const toolName = typeof name === "string" && name.length > 0 ? name : "(unknown)";
  return `${toolName}(${compactJsonForInvocation(argsJson)})`;
}

/**
 * @param {HTMLElement} bubble
 * @param {string} invocation
 * @returns {void}
 */
function appendToolInvocation(bubble, invocation) {
  const pre = document.createElement("pre");
  pre.className = "chat-tool-invocation";
  pre.textContent = invocation;
  bubble.appendChild(pre);
}

/**
 * @param {Record<string, unknown> | null | undefined} documentView
 * @returns {string}
 */
function formatDocumentView(documentView) {
  if (!documentView || typeof documentView !== "object") {
    return "(no document snapshot)";
  }
  const header = [];
  const path =
    typeof documentView.path === "string" && documentView.path.length > 0
      ? documentView.path
      : "(untitled)";
  header.push(`Document: ${path}`);
  if (typeof documentView.lines === "number") {
    header.push(`Total lines: ${documentView.lines}`);
  }
  if (documentView.is_truncated === true) {
    header.push(
      `Context window: lines ${documentView.window_start_line}-${documentView.window_end_line}`
    );
  }
  const numbered =
    typeof documentView.numbered === "string" ? documentView.numbered : "";
  return numbered.length > 0 ? `${header.join("\n")}\n\n${numbered}` : header.join("\n");
}

/**
 * @param {Record<string, unknown>} result
 * @returns {string}
 */
function formatToolResultForLog(result) {
  /** @type {Record<string, unknown>} */
  const display = { ...result };

  if (typeof display.new_text === "string" && display.new_text.length > 400) {
    const len = display.new_text.length;
    display.new_text = `[${len} chars — truncated for display]\n${display.new_text.slice(0, 400)}…`;
  }

  if (typeof display.content === "string" && display.content.length > 3000) {
    const len = display.content.length;
    display.content = `${display.content.slice(0, 3000)}\n… [${len} chars total]`;
  }

  return JSON.stringify(display, null, 2);
}

/**
 * @param {string} summary
 * @returns {string}
 */
function summarizeToolResult(name, result) {
  if (!result || result.ok !== true) {
    return `${name} failed: ${result?.error ?? "unknown error"}`;
  }
  if (name === "get_document") {
    return `${name} returned document snapshot (${result.lines ?? "?"} lines)`;
  }
  if (name === "goto_line") {
    return `${name} → line ${result.line}: ${result.line_text ?? ""}`;
  }
  if (result.changed === false) {
    return `${name} → no change (document unchanged)`;
  }
  if (result.changed === true) {
    return `${name} → document updated`;
  }
  return `${name} → ok`;
}

/**
 * @param {HTMLElement} bubble
 * @param {string} title
 * @param {string} content
 * @returns {void}
 */
function appendLogSection(bubble, title, content) {
  const section = document.createElement("div");
  section.className = "chat-log-section";

  const heading = document.createElement("div");
  heading.className = "chat-log-section-title";
  heading.textContent = title;
  section.appendChild(heading);

  const pre = document.createElement("pre");
  pre.className = "chat-log-pre";
  pre.textContent = content;
  section.appendChild(pre);

  bubble.appendChild(section);
}

/**
 * @param {{
 *   userContent?: string,
 *   systemPrompt?: string,
 *   requestBody?: Record<string, unknown>,
 *   inferenceSummary?: string,
 *   priorTurnsSummary?: string,
 *   messagesJson?: string,
 * }} payload
 * @returns {void}
 */
export function appendAgentContext(payload) {
  if (!messagesEl) return;

  const userContent = typeof payload?.userContent === "string" ? payload.userContent : "";
  const systemPrompt = typeof payload?.systemPrompt === "string" ? payload.systemPrompt : "";
  const inferenceSummary =
    typeof payload?.inferenceSummary === "string" ? payload.inferenceSummary : "";
  const priorTurnsSummary =
    typeof payload?.priorTurnsSummary === "string" ? payload.priorTurnsSummary : "";
  const messagesJson = typeof payload?.messagesJson === "string" ? payload.messagesJson : "";
  const requestBodyText =
    payload?.requestBody && typeof payload.requestBody === "object"
      ? stringifyRequestBody(payload.requestBody)
      : "";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-context";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = "LLM input";
  bubble.appendChild(label);

  if (inferenceSummary.length > 0) {
    appendLogSection(bubble, "LM Studio settings", inferenceSummary);
  }
  if (requestBodyText.length > 0) {
    appendLogSection(bubble, "Outgoing request body (POST /v1/chat/completions)", requestBodyText);
  }
  if (messagesJson.length > 0) {
    appendLogSection(bubble, "Messages array", messagesJson);
  }
  if (priorTurnsSummary.length > 0) {
    appendLogSection(bubble, "Chat history (prior turns)", priorTurnsSummary);
  }
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    appendLogSection(bubble, "System prompt", systemPrompt);
  }
  appendLogSection(
    bubble,
    "User message (as sent to model)",
    userContent
  );

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
}

/**
 * @param {number} turn
 * @param {Record<string, unknown>} requestBody
 * @param {string} [messagesJson]
 * @returns {void}
 */
export function appendAgentTurnRequest(turn, requestBody, messagesJson = "") {
  if (!messagesEl || turn <= 1) return;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-context chat-bubble-turn-request";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = `Agent turn ${turn} → LM Studio`;
  bubble.appendChild(label);

  appendLogSection(
    bubble,
    "Outgoing request body",
    requestBody && typeof requestBody === "object"
      ? stringifyRequestBody(requestBody)
      : ""
  );
  if (typeof messagesJson === "string" && messagesJson.length > 0) {
    appendLogSection(bubble, "Messages array", messagesJson);
  }

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
}

/**
 * @param {number} [turn]
 * @returns {HTMLElement | null}
 */
export function beginReasoningStream(turn = 0) {
  if (!messagesEl) return null;

  finalizeReasoningStream();

  activeReasoningTurn = Number.isFinite(turn) ? Math.trunc(turn) : 0;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-reasoning chat-bubble-reasoning-active";
  if (activeReasoningTurn > 0) {
    bubble.dataset.turn = String(activeReasoningTurn);
  }

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent =
    activeReasoningTurn > 0
      ? `Reasoning (turn ${activeReasoningTurn})`
      : "Reasoning";
  bubble.appendChild(label);

  const body = document.createElement("div");
  body.className = "chat-bubble-body chat-reasoning-body";
  bubble.appendChild(body);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();

  activeReasoningBubble = bubble;
  activeReasoningBody = body;
  return body;
}

/**
 * @param {string} fragment
 * @returns {void}
 */
export function appendReasoningFragment(fragment) {
  if (!activeReasoningBody || typeof fragment !== "string" || fragment.length === 0) {
    return;
  }
  activeReasoningBody.textContent += fragment;
  scrollMessagesToBottom();
}

/**
 * @param {string} [fallbackReasoning]
 * @returns {void}
 */
export function finalizeReasoningStream(fallbackReasoning = "") {
  if (
    activeReasoningBody &&
    activeReasoningBody.textContent?.length === 0 &&
    typeof fallbackReasoning === "string" &&
    fallbackReasoning.length > 0
  ) {
    activeReasoningBody.textContent = fallbackReasoning;
  }

  if (activeReasoningBubble) {
    activeReasoningBubble.classList.remove("chat-bubble-reasoning-active");
  }

  activeReasoningBody = null;
  activeReasoningBubble = null;
  activeReasoningTurn = 0;
}

/**
 * @param {string} content
 * @returns {void}
 */
export function appendAssistantToolTurn(content) {
  if (!messagesEl || typeof content !== "string" || content.length === 0) return;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-agent-turn";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  label.textContent = "Model (tool turn)";
  bubble.appendChild(label);

  appendLogSection(bubble, "Assistant content before tools", content);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
}

/**
 * @param {string} name
 * @param {string} argsJson
 * @param {Record<string, unknown> | null} [documentView]
 * @param {string} [toolCallId]
 * @returns {void}
 */
export function appendToolCall(name, argsJson, documentView = null, toolCallId = "") {
  if (!messagesEl) return;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-tool";
  if (typeof toolCallId === "string" && toolCallId.length > 0) {
    bubble.dataset.toolCallId = toolCallId;
  }

  const label = document.createElement("div");
  label.className = "chat-bubble-label chat-bubble-label-tool";
  label.textContent = "Tool call";
  bubble.appendChild(label);

  appendToolInvocation(bubble, formatToolInvocation(name, argsJson));
  appendLogSection(bubble, "Arguments (formatted)", prettyJson(argsJson));
  appendLogSection(
    bubble,
    "Document before tool (model's view)",
    formatDocumentView(documentView)
  );

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} result
 * @param {string} [toolCallId]
 * @returns {void}
 */
export function appendToolResult(name, result, toolCallId = "", argsJson = "") {
  if (!messagesEl) return;
  const bubble = document.createElement("div");
  const failed = !result || result.ok !== true;
  bubble.className = failed
    ? "chat-bubble chat-bubble-tool-result chat-bubble-tool-failed"
    : "chat-bubble chat-bubble-tool-result";
  if (typeof toolCallId === "string" && toolCallId.length > 0) {
    bubble.dataset.toolCallId = toolCallId;
  }

  const label = document.createElement("div");
  label.className = "chat-bubble-label chat-bubble-label-tool";
  label.textContent = failed ? "Tool failed" : "Tool result";
  bubble.appendChild(label);

  appendToolInvocation(bubble, formatToolInvocation(name, argsJson));
  appendLogSection(bubble, "Summary", summarizeToolResult(name, result ?? {}));
  appendLogSection(
    bubble,
    "Return value (as sent to model)",
    formatToolResultForLog(result ?? {})
  );

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();
}

/**
 * @param {string} [initialText]
 * @returns {HTMLElement | null}
 */
export function beginAssistantMessage(initialText = "") {
  if (!messagesEl) return null;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-bubble-assistant";

  const head = document.createElement("div");
  head.className = "chat-bubble-head";

  const label = document.createElement("div");
  label.className = "chat-bubble-label";
  const modelLabel =
    activeRequestModel.length > 0 ? activeRequestModel : "(no model)";
  label.textContent = modelLabel;
  bubble.dataset.model = modelLabel;
  head.appendChild(label);

  const actions = document.createElement("div");
  actions.className = "chat-bubble-actions";
  head.appendChild(actions);

  bubble.appendChild(head);

  const body = document.createElement("div");
  body.className = "chat-bubble-body";
  body.textContent = initialText;
  bubble.appendChild(body);

  messagesEl.appendChild(bubble);
  scrollMessagesToBottom();

  activeAssistantBubble = bubble;
  activeAssistantBody = body;
  return body;
}

/**
 * @param {HTMLElement} bubble
 * @param {string} assistantText
 * @returns {void}
 */
function attachApplyEditsButton(bubble, assistantText) {
  const edits = extractDocumentEdits(assistantText);
  if (edits.length === 0) return;

  const head = bubble.querySelector(".chat-bubble-head");
  if (!head) return;

  let actions = head.querySelector(".chat-bubble-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "chat-bubble-actions";
    head.appendChild(actions);
  }

  if (actions.querySelector(".chat-apply-edits-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-apply-edits-btn";
  btn.textContent = "Apply to document";
  btn.title = `Apply ${edits.length} edit(s) from this message to the document`;
  btn.addEventListener("click", async () => {
    const applied = await editor.applyDocumentEdits(edits);
    if (applied > 0) {
      btn.textContent = "Applied";
      btn.disabled = true;
    } else {
      btn.textContent = "No changes applied";
    }
  });
  actions.appendChild(btn);
  scrollMessagesToBottom();
}

/**
 * @param {string} fragment
 * @returns {void}
 */
export function appendAssistantFragment(fragment) {
  if (!activeAssistantBody || typeof fragment !== "string" || fragment.length === 0) {
    return;
  }
  activeAssistantBody.textContent += fragment;
  scrollMessagesToBottom();
}

/**
 * @returns {void}
 */
export function finalizeAssistantMessage() {
  if (activeAssistantBubble && activeAssistantBody) {
    attachApplyEditsButton(
      activeAssistantBubble,
      activeAssistantBody.textContent ?? ""
    );
  }
  activeAssistantBody = null;
  activeAssistantBubble = null;
  setStreamingUi(false);
}

/** @type {boolean} */
let chatListenersAttached = false;

/**
 * @returns {void}
 */
export function initializeChat() {
  if (typeof document === "undefined") return;

  messagesEl = document.getElementById("chat-messages");
  inputEl = document.getElementById("chat-input");
  sendBtn = document.getElementById("chat-send");
  clearBtn = document.getElementById("chat-clear");
  modelPickerEl = document.getElementById("chat-model-picker");
  tokenCountEl = document.getElementById("chat-token-count");
  visionIconEl = document.getElementById("chat-cap-vision");
  toolsIconEl = document.getElementById("chat-cap-tools");
  reasoningIconEl = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("chat-cap-reasoning")
  );

  if (reasoningIconEl && !reasoningIconEl.dataset.chatBound) {
    reasoningIconEl.dataset.chatBound = "1";
    reasoningIconEl.addEventListener("click", () => {
      void onReasoningIconClick();
    });
  }

  if (modelPickerEl && !modelPickerEl.dataset.chatBound) {
    modelPickerEl.dataset.chatBound = "1";
    modelPickerEl.addEventListener("focus", () => {
      void loadModelList();
    });
    modelPickerEl.addEventListener("mousedown", () => {
      void loadModelList();
    });
    modelPickerEl.addEventListener("change", () => {
      void onModelPickerChange();
    });
  }

  if (sendBtn && !sendBtn.dataset.chatBound) {
    sendBtn.dataset.chatBound = "1";
    sendBtn.addEventListener("click", () => {
      void sendChatPrompt();
    });
  }

  if (inputEl && !inputEl.dataset.chatBound) {
    inputEl.dataset.chatBound = "1";
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendChatPrompt();
      }
    });
  }

  if (clearBtn && !clearBtn.dataset.chatBound) {
    clearBtn.dataset.chatBound = "1";
    clearBtn.addEventListener("click", () => {
      clearMessages();
    });
  }

  if (chatListenersAttached) return;
  chatListenersAttached = true;

  if (typeof document !== "undefined") {
    document.addEventListener("settings:model-changed", () => {
      void refreshCapabilityIcons(modelPickerEl?.value ?? "");
    });
    document.addEventListener("settings:inference-changed", () => {
      void refreshCapabilityIcons(modelPickerEl?.value ?? "");
    });

    document.addEventListener("editor:chat-start", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const text =
        detail && typeof detail === "object" && typeof detail.text === "string"
          ? detail.text
          : "";
      const model =
        detail && typeof detail === "object" && typeof detail.model === "string"
          ? detail.model
          : modelPickerEl?.value ?? "";
      activeRequestModel = model;
      if (text.length > 0) appendUserMessage(text);
      activeAssistantBody = null;
      setStreamingUi(true);
    });

    document.addEventListener("editor:chat-retry", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const text =
        detail && typeof detail === "object" && typeof detail.text === "string"
          ? detail.text
          : "";
      const model =
        detail && typeof detail === "object" && typeof detail.model === "string"
          ? detail.model
          : modelPickerEl?.value ?? "";
      activeRequestModel = model;
      if (pendingUserBubble && text.length > 0) {
        clearUserBubbleFailure(pendingUserBubble);
      }
      activeAssistantBody = null;
      setStreamingUi(true);
    });

    document.addEventListener("editor:chat-assistant", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const message =
        detail && typeof detail === "object" && typeof detail.message === "string"
          ? detail.message
          : "";
      if (message.length === 0) return;
      if (!activeAssistantBody) {
        beginAssistantMessage(message);
      } else {
        activeAssistantBody.textContent = message;
        scrollMessagesToBottom();
      }
    });

    document.addEventListener("editor:chat-unapplied-edits", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const message =
        detail && typeof detail === "object" && typeof detail.message === "string"
          ? detail.message
          : "";
      if (message.length === 0) return;
      const bubble = activeAssistantBubble;
      if (bubble) {
        attachApplyEditsButton(bubble, message);
      }
    });

    document.addEventListener("editor:agent-context", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      if (!detail || typeof detail !== "object") return;
      appendAgentContext(detail);
    });

    document.addEventListener("editor:agent-turn-request", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const turn =
        detail && typeof detail === "object" && typeof detail.turn === "number"
          ? detail.turn
          : 0;
      const requestBody =
        detail && typeof detail === "object" && detail.requestBody
          ? detail.requestBody
          : null;
      const messagesJson =
        detail && typeof detail === "object" && typeof detail.messagesJson === "string"
          ? detail.messagesJson
          : "";
      if (turn > 1 && requestBody && typeof requestBody === "object") {
        appendAgentTurnRequest(turn, requestBody, messagesJson);
      }
    });

    document.addEventListener("editor:reasoning-stream-start", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const turn =
        detail && typeof detail === "object" && typeof detail.turn === "number"
          ? detail.turn
          : 0;
      beginReasoningStream(turn);
    });

    document.addEventListener("editor:reasoning-stream-token", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const fragment =
        detail && typeof detail === "object" && typeof detail.fragment === "string"
          ? detail.fragment
          : "";
      appendReasoningFragment(fragment);
    });

    document.addEventListener("editor:reasoning-stream-end", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const reasoning =
        detail && typeof detail === "object" && typeof detail.reasoning === "string"
          ? detail.reasoning
          : "";
      finalizeReasoningStream(reasoning);
    });

    document.addEventListener("editor:agent-tool-turn", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const content =
        detail && typeof detail === "object" && typeof detail.content === "string"
          ? detail.content
          : "";
      appendAssistantToolTurn(content);
    });

    document.addEventListener("editor:tool-call", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const toolCall =
        detail && typeof detail === "object" && detail.toolCall ? detail.toolCall : null;
      const documentView =
        detail && typeof detail === "object" && detail.documentView
          ? detail.documentView
          : null;
      if (!toolCall || typeof toolCall.name !== "string") return;
      appendToolCall(
        toolCall.name,
        toolCall.arguments ?? "{}",
        documentView,
        toolCall.id ?? ""
      );
    });

    document.addEventListener("editor:tool-result", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const toolCall =
        detail && typeof detail === "object" && detail.toolCall ? detail.toolCall : null;
      const result =
        detail && typeof detail === "object" && detail.result ? detail.result : null;
      if (!toolCall || typeof toolCall.name !== "string") return;
      appendToolResult(
        toolCall.name,
        result ?? {},
        toolCall.id ?? "",
        toolCall.arguments ?? "{}"
      );
    });

    document.addEventListener("editor:chat-token", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const fragment =
        detail && typeof detail === "object" && typeof detail.fragment === "string"
          ? detail.fragment
          : "";
      appendAssistantFragment(fragment);
    });

    document.addEventListener("editor:chat-complete", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const success =
        !detail || typeof detail !== "object" || detail.success !== false;

      finalizeAssistantMessage();

      if (!success) {
        const error =
          detail && typeof detail === "object" && typeof detail.error === "string"
            ? detail.error
            : "Request failed";
        markPendingUserBubbleFailed(error);
        updateTokenCount();
        return;
      }

      if (pendingUserBubble) {
        clearUserBubbleFailure(pendingUserBubble);
      }
      pendingUserBubble = null;
      updateTokenCount();
    });
  }
}

/**
 * @returns {Promise<void>}
 */
async function sendChatPrompt() {
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (text.length === 0) return;
  inputEl.value = "";
  await editor.sendChatMessage(text);
}

export const _internal = {
  appendUserMessage,
  markPendingUserBubbleFailed,
  clearUserBubbleFailure,
  getPendingUserBubble: () => pendingUserBubble,
};
