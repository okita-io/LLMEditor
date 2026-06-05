// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Frontend agent loop — multi-turn tool use against LM Studio.

import * as api from "./api.js";
import {
  buildAgentRequestPreview,
  formatInferenceSettingsSummary,
  formatPriorTurnsForLog,
  stringifyRequestBody,
} from "./agent_request_preview.js";
import * as editorTools from "./editor_tools.js";
import {
  buildContextWindow,
  formatAgentUserMessage,
  refreshContextWindow,
} from "./context_window.js";
import { assistantTextLooksLikeUnappliedEdits } from "./document_edits.js";
import {
  getAgentToolSchemas,
  isUserCustomTool,
  executeAgentTool,
} from "./tool_editor.js";

const MAX_TURNS = 16;

const APPLY_NUDGE =
  "You described document changes in chat but did not apply them with tools. Use the tools provided in this session to write those edits into the document. Do not send another prose-only reply until the tools have run.";

const THINKING_NUDGE =
  "You responded with text but did not call any tools. Please use the provided tools to make the requested changes now. Do not explain — just call the tools.";

/**
 * @param {object} settings
 * @returns {string}
 */
function buildSystemPrompt(settings) {
  if (settings && typeof settings.system_prompt === "string") {
    return settings.system_prompt.trim();
  }
  return "";
}

/**
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
function parseToolArguments(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args;
  }
  return {};
}

/**
 * @typedef {object} AgentCallbacks
 * @property {() => { text: string, path?: string|null, contextAnchor?: ReturnType<typeof buildContextWindow>|null }} getDocumentContext
 * @property {(toolCall: { id: string, name: string, arguments: string }, documentView: Record<string, unknown>) => void} [onToolCall]
 * @property {(toolCall: { id: string, name: string, arguments: string }, result: Record<string, unknown>) => void} [onToolResult]
 * @property {(payload: {
 *   userContent: string,
 *   systemPrompt: string,
 *   requestBody: Record<string, unknown>,
 *   inferenceSummary: string,
 *   priorTurnsSummary: string,
 *   messagesJson: string,
 * }) => void} [onAgentContext]
 * @property {(payload: { turn: number, requestBody: Record<string, unknown>, messagesJson: string }) => void} [onAgentTurnRequest]
 * @property {(payload: { turn: number }) => void} [onReasoningStreamStart]
 * @property {(payload: { turn: number, reasoning?: string|null }) => void} [onReasoningStreamEnd]
 * @property {(content: string) => void} [onAssistantToolTurn]
 * @property {(text: string) => void} [onAssistantMessage]
 * @property {(bufferEl: HTMLTextAreaElement, name: string, result: Record<string, unknown>) => void} [applyMutatingResult]
 * @property {(text: string) => void} [onUnappliedEditsHint]
 */

/**
 * @typedef {object} RunAgentOptions
 * @property {string} userMessage
 * @property {object} settings
 * @property {HTMLTextAreaElement} bufferEl
 * @property {ReturnType<typeof buildContextWindow>|null} [contextAnchor]
 * @property {string|null} [documentPath]
 * @property {Array<{ role: "user" | "assistant", content: string }>} [priorTurns]
 * @property {AgentCallbacks} callbacks
 */

/**
 * Run the tool-use agent loop until the model stops calling tools.
 *
 * @param {RunAgentOptions} options
 * @returns {Promise<string>}
 */
/**
 * @param {{ text: string, path?: string|null, contextAnchor?: ReturnType<typeof buildContextWindow>|null }} ctx
 * @param {HTMLTextAreaElement} bufferEl
 * @param {ReturnType<typeof buildContextWindow>|null} fallbackAnchor
 * @returns {ReturnType<typeof buildContextWindow>|null}
 */
function resolveLiveContextWindow(ctx, bufferEl, fallbackAnchor) {
  if (ctx.contextAnchor && typeof ctx.contextAnchor === "object") {
    return ctx.contextAnchor;
  }
  if (fallbackAnchor && typeof fallbackAnchor === "object") {
    return refreshContextWindow(bufferEl.value, fallbackAnchor);
  }
  return null;
}

/**
 * Parse a raw OpenAI-compat chat-completions response envelope into the
 * same shape that the Rust `agent_turn` command returns.
 * Kept for tests and debugging previews.
 *
 * @param {unknown} envelope
 * @returns {{ content: string|null, tool_calls: Array<{ id: string, name: string, arguments: string }>, finish_reason: string|null, reasoning: string|null }}
 */
function parseAgentTurnEnvelope(envelope) {
  const choice =
    envelope &&
    typeof envelope === "object" &&
    Array.isArray(envelope.choices) &&
    envelope.choices[0];

  if (!choice || typeof choice !== "object") {
    throw new Error("No response choices from model");
  }

  const message =
    choice.message && typeof choice.message === "object" ? choice.message : {};

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
  const reasoning =
    message.reasoning && typeof message.reasoning === "string"
      ? message.reasoning
      : null;

  return { content, tool_calls, finish_reason, reasoning };
}

/** User stopped the agent loop (Stop button / Escape). */
export class AgentCancelledError extends Error {
  constructor() {
    super("stopped");
    this.name = "AgentCancelledError";
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAgentCancelledError(err) {
  return err instanceof AgentCancelledError;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isLlmCancelledError(err) {
  if (isAgentCancelledError(err)) return true;
  const msg = err && typeof err === "object" && "message" in err ? err.message : err;
  return typeof msg === "string" && msg.length === 0;
}

export async function runAgent(options) {
  const { userMessage, settings, bufferEl, callbacks, documentPath = null } = options;
  const getContext = callbacks.getDocumentContext;
  const contextAnchor = options.contextAnchor ?? null;
  const ctx = getContext();
  const liveWindow = resolveLiveContextWindow(ctx, bufferEl, contextAnchor);

  const userContent =
    liveWindow !== null
      ? formatAgentUserMessage(
          userMessage,
          liveWindow,
          documentPath ?? ctx.path ?? null
        )
      : userMessage;

  const priorTurns = Array.isArray(options.priorTurns) ? options.priorTurns : [];

  const systemPrompt = buildSystemPrompt(settings);

  /** @type {Array<Record<string, unknown>>} */
  const messages = [
    ...(systemPrompt.length > 0
      ? [{ role: "system", content: systemPrompt }]
      : []),
    ...priorTurns.map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: "user", content: userContent },
  ];
  const initialRequestBody = buildAgentRequestPreview(settings, messages, getAgentToolSchemas());

  callbacks.onAgentContext?.({
    userContent,
    systemPrompt,
    requestBody: initialRequestBody,
    inferenceSummary: formatInferenceSettingsSummary(settings),
    priorTurnsSummary: formatPriorTurnsForLog(priorTurns),
    messagesJson: stringifyRequestBody(messages),
  });

  let finalText = "";
  let mutatingToolCount = 0;
  let applyNudgeUsed = false;
  let thinkingNudgeUsed = false;

  const shouldAbort =
    typeof options.shouldAbort === "function" ? options.shouldAbort : () => false;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (shouldAbort()) {
      throw new AgentCancelledError();
    }

    const turnNumber = turn + 1;
    const customTools = getAgentToolSchemas();
    const requestBody = buildAgentRequestPreview(settings, messages, customTools);

    callbacks.onAgentTurnRequest?.({
      turn: turnNumber,
      requestBody,
      messagesJson: stringifyRequestBody(messages),
    });
    callbacks.onReasoningStreamStart?.({ turn: turnNumber });

    let response;
    try {
      response = await api.agentTurn(messages, settings, customTools);
    } catch (err) {
      if (isLlmCancelledError(err)) {
        throw new AgentCancelledError();
      }
      throw err;
    }

    if (shouldAbort()) {
      throw new AgentCancelledError();
    }

    callbacks.onReasoningStreamEnd?.({
      turn: turnNumber,
      reasoning:
        typeof response.reasoning === "string" && response.reasoning.length > 0
          ? response.reasoning
          : null,
    });

    if (response.tool_calls && response.tool_calls.length > 0) {
      /** @type {Record<string, unknown>} */
      const assistantMessage = {
        role: "assistant",
        content: response.content ?? null,
        tool_calls: response.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      messages.push(assistantMessage);

      if (typeof response.content === "string" && response.content.length > 0) {
        callbacks.onAssistantToolTurn?.(response.content);
      }

      for (const toolCall of response.tool_calls) {
        if (shouldAbort()) {
          throw new AgentCancelledError();
        }
        const ctx = getContext();
        // eslint-disable-next-line no-await-in-loop
        const snap = await executeAgentTool("get_document", {}, {
          ...ctx,
          refreshWindow: refreshContextWindow,
        });
        if (snap && snap.ok === true && typeof snap.content === "string") {
          callbacks.onToolCall?.(toolCall, {
            numbered: snap.content,
            path: snap.path,
            lines: snap.lines,
            is_truncated: snap.is_truncated,
            window_start_line: snap.window_start_line,
            window_end_line: snap.window_end_line,
          });
        } else {
          // Fallback: the loaded Tool_File lacks a usable get_document.
          // Show the raw buffer text with no renumbering (display-only;
          // does not reconstruct tool logic in the harness).
          const rawText = typeof ctx.text === "string" ? ctx.text : "";
          callbacks.onToolCall?.(toolCall, {
            numbered: rawText,
            path: ctx.path ?? null,
            lines: rawText.length === 0 ? 0 : rawText.split("\n").length,
            is_truncated: false,
            window_start_line: 1,
            window_end_line: rawText.length === 0 ? 0 : rawText.split("\n").length,
          });
        }

        let parsedArgs = {};
        let parseError = null;
        try {
          parsedArgs = parseToolArguments(JSON.parse(toolCall.arguments));
        } catch {
          parseError = "invalid tool arguments JSON";
          parsedArgs = {};
        }

        // eslint-disable-next-line no-await-in-loop
        const execCtx = {
          ...ctx,
          toolName: toolCall.name,
          refreshWindow: refreshContextWindow,
        };

        let result;
        if (parseError) {
          result = { ok: false, error: parseError, changed: false };
        } else if (isUserCustomTool(toolCall.name)) {
          result = await executeAgentTool(toolCall.name, parsedArgs, execCtx);
        } else {
          result = {
            ok: false,
            error: `Unknown tool: ${toolCall.name}`,
            changed: false,
          };
        }

        if (result.ok === true && result.changed === true) {
          mutatingToolCount += 1;
        }

        if (callbacks.applyMutatingResult) {
          callbacks.applyMutatingResult(bufferEl, toolCall.name, result);
        } else {
          editorTools.applyToolSideEffects(bufferEl, toolCall.name, result);
        }

        callbacks.onToolResult?.(toolCall, result);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    if (typeof response.content === "string" && response.content.length > 0) {
      finalText = response.content;

      const pendingNudge =
        !applyNudgeUsed &&
        mutatingToolCount === 0 &&
        assistantTextLooksLikeUnappliedEdits(response.content);

      if (pendingNudge) {
        applyNudgeUsed = true;
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: APPLY_NUDGE });
        continue;
      }

      // If the model responded with text (possibly thinking) but made
      // no tool calls and hasn't mutated the document yet, give it one
      // more chance to act. This handles models that emit <think> tags
      // or chain-of-thought before calling tools.
      if (!thinkingNudgeUsed && mutatingToolCount === 0) {
        thinkingNudgeUsed = true;
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: THINKING_NUDGE });
        continue;
      }

      callbacks.onAssistantMessage?.(response.content);

      if (
        mutatingToolCount === 0 &&
        assistantTextLooksLikeUnappliedEdits(response.content)
      ) {
        callbacks.onUnappliedEditsHint?.(response.content);
      }
    }
    break;
  }

  return finalText;
}

export const _internal = {
  buildSystemPrompt,
  MAX_TURNS,
  resolveLiveContextWindow,
  parseAgentTurnEnvelope,
};
