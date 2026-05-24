// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import {
  clearHistory,
  getHistoryForAgent,
  recordExchange,
  MAX_CHAT_HISTORY_CHARS,
  MAX_CHAT_TURNS,
  _internal,
} from "../chat_history.js";

afterEach(() => {
  clearHistory();
});

describe("chat_history", () => {
  it("returns prior turns for the agent in order", () => {
    recordExchange("remove item A", "Removed item A.");
    recordExchange("put item A back", "Restored item A.");

    expect(getHistoryForAgent()).toEqual([
      { role: "user", content: "remove item A" },
      { role: "assistant", content: "Removed item A." },
      { role: "user", content: "put item A back" },
      { role: "assistant", content: "Restored item A." },
    ]);
  });

  it("records user-only exchanges when the assistant reply is empty", () => {
    recordExchange("remove item A", "");

    expect(getHistoryForAgent()).toEqual([
      { role: "user", content: "remove item A" },
    ]);
  });

  it("drops oldest turns when over the turn cap", () => {
    for (let i = 0; i < MAX_CHAT_TURNS + 4; i += 1) {
      recordExchange(`user ${i}`, `assistant ${i}`);
    }

    const history = getHistoryForAgent();
    expect(history).toHaveLength(MAX_CHAT_TURNS);
    expect(history[0]).toEqual({ role: "user", content: "user 14" });
  });

  it("drops oldest turns when over the character budget", () => {
    const longText = "x".repeat(MAX_CHAT_HISTORY_CHARS + 100);
    recordExchange(longText, "done");
    recordExchange("latest request", "latest reply");

    const history = getHistoryForAgent();
    expect(history.some((turn) => turn.content === longText)).toBe(false);
    expect(history.at(-2)).toEqual({ role: "user", content: "latest request" });
    expect(history.at(-1)).toEqual({ role: "assistant", content: "latest reply" });
  });

  it("clears stored history", () => {
    recordExchange("hello", "hi");
    clearHistory();
    expect(getHistoryForAgent()).toEqual([]);
  });
});

describe("chat_history _internal.trimTurns", () => {
  it("preserves order while trimming", () => {
    const trimmed = _internal.trimTurns([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    expect(trimmed).toHaveLength(3);
  });
});
