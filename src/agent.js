// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Frontend agent loop — multi-turn tool use against LM Studio.

import * as api from "./api.js";
import * as editorTools from "./editor_tools.js";
import {
  buildContextWindow,
  formatAgentUserMessage,
} from "./context_window.js";
import { assistantTextLooksLikeUnappliedEdits } from "./document_edits.js";

const MAX_TURNS = 16;

const APPLY_NUDGE =
  "You described document changes in chat but did not apply them with tools. Use replace_range, insert_text, or delete_range now to write those edits into the document. Do not send another prose-only reply until the tools have run.";

const THINKING_NUDGE =
  "You responded with text but did not call any tools. Please use the provided tools (replace_range, insert_text, delete_range, get_document, goto_line) to make the requested changes now. Do not explain — just call the tools.";

const DEFAULT_TOOL_SYSTEM = `You are an AI assistant editing a plain-text document in LLIMEdit.
Use the provided tools to inspect and modify the document. Line numbers are 1-based and absolute in the full file.
The user message includes a context window around their selection or caret when the document is large; lines marked with ">>" are selected.
Call get_document when you need to re-read the current buffer (returns the same context window for large files).
Use replace_range to rewrite line ranges, insert_text for insertions, delete_range to remove lines, and goto_line to inspect a specific line.
You MUST apply every document change with tools before your final reply. Do not paste JSON patches, outline snippets, or replacement text in chat as a substitute for tool calls — the chat panel is not the document.
After tools succeed, summarize briefly in plain language only. If you proposed new sections (e.g. build-up, threshold), insert them with insert_text or replace_range.`;

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
 * @property {(toolCall: { id: string, name: string, arguments: string }) => void} [onToolCall]
 * @property {(toolCall: { id: string, name: string, arguments: string }, result: Record<string, unknown>) => void} [onToolResult]
 * @property {(text: string) => void} [onAssistantMessage]
 * @property {(bufferEl: HTMLTextAreaElement, name: string, result: Record<string, unknown>) => void} [applyMutatingResult]
 * @property {(text: string) => void} [onUnappliedEditsHint]
 */

const MUTATING_TOOLS = new Set(["insert_text", "replace_range", "delete_range"]);

/**
 * @typedef {object} RunAgentOptions
 * @property {string} userMessage
 * @property {object} settings
 * @property {HTMLTextAreaElement} bufferEl
 * @property {ReturnType<typeof buildContextWindow>|null} [contextAnchor]
 * @property {string|null} [documentPath]
 * @property {AgentCallbacks} callbacks
 */

/**
 * Run the tool-use agent loop until the model stops calling tools.
 *
 * @param {RunAgentOptions} options
 * @returns {Promise<string>}
 */
export async function runAgent(options) {
  const { userMessage, settings, bufferEl, callbacks, documentPath = null } = options;
  const getContext = callbacks.getDocumentContext;
  const contextAnchor = options.contextAnchor ?? null;

  const userContent =
    contextAnchor !== null
      ? formatAgentUserMessage(userMessage, contextAnchor, documentPath)
      : userMessage;

  /** @type {Array<Record<string, unknown>>} */
  const messages = [
    { role: "system", content: buildSystemPrompt(settings) },
    { role: "user", content: userContent },
  ];

  let finalText = "";
  let mutatingToolCount = 0;
  let applyNudgeUsed = false;
  let thinkingNudgeUsed = false;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await api.agentTurn(messages, settings);

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

      for (const toolCall of response.tool_calls) {
        callbacks.onToolCall?.(toolCall);

        let parsedArgs = {};
        let parseError = null;
        try {
          parsedArgs = parseToolArguments(JSON.parse(toolCall.arguments));
        } catch {
          parseError = "invalid tool arguments JSON";
          parsedArgs = {};
        }

        const ctx = getContext();
        const result = parseError
          ? { ok: false, error: parseError, changed: false }
          : editorTools.executeTool(toolCall.name, parsedArgs, ctx);

        if (
          result.ok === true &&
          result.changed !== false &&
          MUTATING_TOOLS.has(toolCall.name)
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
};
