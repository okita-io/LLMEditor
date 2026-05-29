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
  executeDefaultTool,
  isDefaultTool,
} from "./default_tools.js";
import {
  getAgentTools,
  isUserCustomTool,
  executeCustomTool,
} from "./tool_editor.js";

const MAX_TURNS = 16;

const APPLY_NUDGE =
  "You described document changes in chat but did not apply them with tools. Use replace_line, replace_span, insert_text, delete_lines, or delete_span now to write those edits into the document. Do not send another prose-only reply until the tools have run.";

const THINKING_NUDGE =
  "You responded with text but did not call any tools. Please use the provided tools (replace_line, replace_span, insert_text, delete_lines, delete_span, get_document, goto_line) to make the requested changes now. Do not explain — just call the tools.";

const DEFAULT_TOOL_SYSTEM = `You are an AI assistant editing a plain-text document in LLIMEdit.
Built-in document tools are provided via default.lmtools; use the provided tools to inspect and modify the document. Line numbers are 1-based and absolute in the full file.
Earlier user and assistant messages in this session are included for continuity; only the latest user message includes the current document excerpt.
The user message includes a context window around their selection or caret when the document is large; lines marked with ">>" are selected.
Call get_document when you need to re-read the current buffer (returns the same context window for large files).
Use replace_line to rewrite an entire line, replace_span to change part of a line, insert_text for insertions, delete_lines to remove whole lines, delete_span to remove part of a line (1-based inclusive columns; columns past end-of-line extend to the line end), and goto_line to inspect a specific line.
You MUST apply every document change with tools before your final reply. Do not paste JSON patches, outline snippets, or replacement text in chat as a substitute for tool calls — the chat panel is not the document.
After tools succeed, summarize briefly in plain language only. If you proposed new sections (e.g. build-up, threshold), insert them with insert_text or replace_line.

TOOL CALL EXAMPLES:

To replace line 3 with new content:
  → call replace_line with {"line": 3, "text": "This is the new line content."}

To insert two new lines after line 10 (inserts at line 11, column 1):
  → call insert_text with {"line": 11, "column": 1, "text": "First new line\\nSecond new line\\n"}

To delete lines 5 through 7:
  → call delete_lines with {"start_line": 5, "end_line": 7}

To change "foo" to "bar" on line 4 (columns 10-12):
  → call replace_span with {"line": 4, "start_column": 10, "end_column": 12, "text": "bar"}

To add content after the last line of the document (e.g. line 38):
  → call insert_text with {"line": 38, "column": 1, "text": "\\nnew content here"}

IMPORTANT: Use the tool calling mechanism directly. Do NOT write code blocks, Python calls, or function invocations in your message. Call the tools through the API.`;

/**
 * @param {object} settings
 * @returns {string}
 */
function buildSystemPrompt(settings) {
  const custom =
    settings && typeof settings.system_prompt === "string"
      ? settings.system_prompt.trim()
      : "";
  if (custom.length > 0) {
    return `${custom}\n\n${DEFAULT_TOOL_SYSTEM}`;
  }
  return DEFAULT_TOOL_SYSTEM;
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

const MUTATING_TOOLS = new Set([
  "insert_text",
  "replace_line",
  "replace_span",
  "delete_lines",
  "delete_span",
]);

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

  /** @type {Array<Record<string, unknown>>} */
  const messages = [
    { role: "system", content: buildSystemPrompt(settings) },
    ...priorTurns.map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: "user", content: userContent },
  ];

  const systemPrompt = buildSystemPrompt(settings);
  const initialRequestBody = buildAgentRequestPreview(settings, messages, getAgentTools());

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

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const turnNumber = turn + 1;
    const customTools = getAgentTools();
    const requestBody = buildAgentRequestPreview(settings, messages, customTools);

    callbacks.onAgentTurnRequest?.({
      turn: turnNumber,
      requestBody,
      messagesJson: stringifyRequestBody(messages),
    });
    callbacks.onReasoningStreamStart?.({ turn: turnNumber });

    const response = await api.agentTurn(messages, settings, customTools);

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
        const ctx = getContext();
        const docSnap = editorTools.getDocumentSnapshot(
          ctx.text,
          ctx.path ?? null,
          ctx.contextAnchor ?? null
        );
        callbacks.onToolCall?.(toolCall, {
          numbered: docSnap.numbered,
          path: docSnap.path,
          lines: docSnap.lines,
          is_truncated: docSnap.is_truncated,
          window_start_line: docSnap.window_start_line,
          window_end_line: docSnap.window_end_line,
        });

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
          editorTools,
        };

        let result;
        if (parseError) {
          result = { ok: false, error: parseError, changed: false };
        } else if (isDefaultTool(toolCall.name)) {
          result = await executeDefaultTool(toolCall.name, parsedArgs, execCtx);
        } else if (isUserCustomTool(toolCall.name)) {
          result = await executeCustomTool(toolCall.name, parsedArgs, execCtx);
        } else {
          result = {
            ok: false,
            error: `Unknown tool: ${toolCall.name}`,
            changed: false,
          };
        }

        if (
          result.ok === true &&
          result.changed !== false &&
          (MUTATING_TOOLS.has(toolCall.name) || isUserCustomTool(toolCall.name))
        ) {
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
  DEFAULT_TOOL_SYSTEM,
  resolveLiveContextWindow,
  parseAgentTurnEnvelope,
};
