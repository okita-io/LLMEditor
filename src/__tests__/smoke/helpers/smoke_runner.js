// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Reusable smoke test runner that executes a scenario against the live
// LLM and validates the result. Captures tool calls, timing, and errors
// for structured logging.

import * as editor from "../../../editor.js";
import { logResult } from "./smoke_logger.js";
import { setupEditorHarness, selectRange, selectSubstring } from "./editor_harness.js";

/**
 * @typedef {import("./smoke_scenarios.js").SmokeScenario} SmokeScenario
 */

/**
 * Run a single smoke scenario against the live LLM.
 *
 * @param {SmokeScenario} scenario
 * @param {{ model: string, maxRetries?: number }} opts
 * @returns {Promise<{ pass: boolean, reason: string, result: string }>}
 */
export async function runScenario(scenario, opts) {
  const maxRetries = scenario.retries ?? opts.maxRetries ?? 1;
  let lastOutcome = { pass: false, reason: "not run", result: "" };

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const outcome = await _executeOnce(scenario, opts, attempt);
    lastOutcome = outcome;
    if (outcome.pass) break;
  }

  return lastOutcome;
}

/**
 * @param {SmokeScenario} scenario
 * @param {{ model: string }} opts
 * @param {number} attempt
 * @returns {Promise<{ pass: boolean, reason: string, result: string }>}
 */
async function _executeOnce(scenario, opts, attempt) {
  const el = setupEditorHarness(scenario.document);

  if (scenario.selection) {
    const { start, end } = selectSubstring(scenario.document, scenario.selection);
    selectRange(el, start, end);
  }

  /** @type {Array<{ name: string, args: string }>} */
  const toolCalls = [];
  /** @type {string[]} */
  const assistantMessages = [];
  /** @type {string[]} */
  const errors = [];
  let agentTurns = 0;

  // Listen for tool-call and tool-result events
  const onToolCall = (e) => {
    const tc = e?.detail?.toolCall;
    if (tc) {
      toolCalls.push({ name: tc.name, args: tc.arguments ?? "{}" });
      agentTurns += 1;
    }
  };
  const onAssistant = (e) => {
    const msg = e?.detail?.message;
    if (msg) assistantMessages.push(msg);
  };
  const onStatus = (e) => {
    const msg = e?.detail?.message;
    if (msg && msg.length > 0 && msg !== "Thinking…") {
      errors.push(msg);
    }
  };

  document.addEventListener("editor:tool-call", onToolCall);
  document.addEventListener("editor:chat-assistant", onAssistant);
  document.addEventListener("editor:status", onStatus);

  const startTime = Date.now();
  let result = "";

  try {
    await editor.sendChatMessage(scenario.prompt);
    result = el.value;
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    result = el.value;
  }

  const durationMs = Date.now() - startTime;

  document.removeEventListener("editor:tool-call", onToolCall);
  document.removeEventListener("editor:chat-assistant", onAssistant);
  document.removeEventListener("editor:status", onStatus);

  const validation = scenario.validate(result);

  logResult({
    scenario: scenario.name,
    tool: scenario.tool,
    prompt: scenario.prompt,
    document: scenario.document.slice(0, 500),
    result: result.slice(0, 1000),
    pass: validation.pass,
    reason: validation.reason,
    durationMs,
    agentTurns,
    toolCalls,
    assistantMessages,
    errors,
    attempt,
    model: opts.model,
    timestamp: new Date().toISOString(),
  });

  return { pass: validation.pass, reason: validation.reason, result };
}
