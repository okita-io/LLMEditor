// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Rolling in-memory chat transcript for multi-turn agent requests.

/** Maximum user/assistant messages kept for LLM context. */
export const MAX_CHAT_TURNS = 20;

/** Character budget for stored chat turns (oldest dropped first). */
export const MAX_CHAT_HISTORY_CHARS = 32000;

/** @type {Array<{ role: "user" | "assistant", content: string }>} */
let turns = [];

/**
 * @param {Array<{ role: "user" | "assistant", content: string }>} items
 * @returns {Array<{ role: "user" | "assistant", content: string }>}
 */
function trimTurns(items) {
  let trimmed = items.slice();

  while (trimmed.length > MAX_CHAT_TURNS) {
    trimmed.shift();
  }

  let totalChars = trimmed.reduce((sum, turn) => sum + turn.content.length, 0);
  while (totalChars > MAX_CHAT_HISTORY_CHARS && trimmed.length > 0) {
    const removed = trimmed.shift();
    totalChars -= removed.content.length;
  }

  return trimmed;
}

/**
 * @returns {Array<{ role: "user" | "assistant", content: string }>}
 */
export function getHistoryForAgent() {
  return turns.map((turn) => ({ role: turn.role, content: turn.content }));
}

/**
 * Record a completed chat exchange after a successful agent run.
 *
 * @param {string} userText
 * @param {string} assistantText
 * @returns {void}
 */
export function recordExchange(userText, assistantText) {
  const user =
    typeof userText === "string" && userText.length > 0 ? userText.trim() : "";
  const assistant =
    typeof assistantText === "string" && assistantText.length > 0
      ? assistantText.trim()
      : "";

  if (user.length === 0) return;

  const next = turns.slice();
  next.push({ role: "user", content: user });
  if (assistant.length > 0) {
    next.push({ role: "assistant", content: assistant });
  }
  turns = trimTurns(next);
}

/**
 * @returns {void}
 */
export function clearHistory() {
  turns = [];
}

export const _internal = {
  trimTurns,
  getTurns: () => turns.slice(),
};
