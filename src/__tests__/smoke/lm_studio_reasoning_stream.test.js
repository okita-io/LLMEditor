// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Live LM Studio reasoning-stream smoke test — skipped unless LLM_SMOKE=1.
//
// Verifies that reasoning content streamed by the model over the
// OpenAI-compatible /v1/chat/completions endpoint (as `delta.reasoning` /
// `delta.reasoning_content`) is forwarded through the same DOM event channel
// the production app uses (`tauri://llm-reasoning-token` → `main.js` →
// `editor:reasoning-stream-token`) and rendered incrementally into the chat
// panel's reasoning bubble.
//
// Run with: LLM_SMOKE=1 npm run test:smoke
//
// Requires a reasoning-style model loaded in LM Studio that emits a separate
// reasoning channel while streaming (e.g. silver-siren-12b). Set LLM_MODEL to
// pin a specific one.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as editor from "../../editor.js";
import {
  getLastRequestBody,
  getSmokeConfig,
  installLmStudioBridge,
  liveAgentTurnStreaming,
  pingLmStudio,
} from "./helpers/lm_studio_client.js";
import { setupChatHarness } from "./helpers/editor_harness.js";

const config = getSmokeConfig();
const smokeEnabled = config.enabled;

// A prompt that nudges the model to think before answering. Reasoning-capable
// models route the chain-of-thought through the reasoning channel; models that
// surface thinking via `<think>` parsing (e.g. silver-siren-12b) need the tags
// requested explicitly, which LM Studio then splits into `reasoning_content`.
const REASONING_PROMPT =
  "Solve 17 times 3. Put your step-by-step reasoning inside <think></think> tags, then state the final answer.";

describe.skipIf(!smokeEnabled)("LM Studio reasoning stream", () => {
  let model = "";

  beforeAll(async () => {
    const ok = await pingLmStudio(config.apiUrl);
    if (!ok) {
      throw new Error(`LM Studio not reachable at ${config.apiUrl}`);
    }
    const bridge = await installLmStudioBridge(config, { stream: true });
    model = bridge.model;
  }, config.timeoutMs);

  beforeEach(async () => {
    document.body.innerHTML = "";
    await installLmStudioBridge(config, { stream: true });
  });

  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  it("sends a streaming request body with tools", async () => {
    const { settings } = await installLmStudioBridge(config, { stream: true });
    await liveAgentTurnStreaming(
      [{ role: "user", content: REASONING_PROMPT }],
      settings,
      config
    );

    const body = getLastRequestBody();
    expect(body).toBeTruthy();
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
  }, config.timeoutMs);

  it("streams reasoning fragments incrementally as DOM events", async () => {
    const { settings } = await installLmStudioBridge(config, { stream: true });

    /** @type {string[]} */
    const fragments = [];
    const onToken = (e) => {
      const fragment = e?.detail?.fragment;
      if (typeof fragment === "string") fragments.push(fragment);
    };
    document.addEventListener("editor:reasoning-stream-token", onToken);

    let response;
    try {
      response = await liveAgentTurnStreaming(
        [{ role: "user", content: REASONING_PROMPT }],
        settings,
        config
      );
    } finally {
      document.removeEventListener("editor:reasoning-stream-token", onToken);
    }

    // The model must have produced a separate reasoning channel; otherwise
    // this model is not a valid target for this scenario.
    expect(
      response.reasoning,
      "model did not emit a reasoning channel — load a reasoning-capable model or set LLM_MODEL"
    ).toBeTruthy();

    // Reasoning arrived as multiple deltas, not one blob.
    expect(fragments.length).toBeGreaterThan(1);

    // The concatenated fragments reconstruct the aggregated reasoning string.
    expect(fragments.join("")).toBe(response.reasoning);
  }, config.timeoutMs);

  it("renders streamed reasoning into the chat panel bubble", async () => {
    const { messages } = setupChatHarness("");

    await editor.sendChatMessage(REASONING_PROMPT);

    const bubble = messages.querySelector(".chat-bubble-reasoning");
    expect(bubble, "no reasoning bubble was rendered in the chat panel").toBeTruthy();

    // The streaming run is complete, so the active marker is cleared.
    expect(bubble.classList.contains("chat-bubble-reasoning-active")).toBe(false);

    const body = bubble.querySelector(".chat-reasoning-body");
    expect(body).toBeTruthy();
    expect(body.textContent.length).toBeGreaterThan(0);
  }, config.timeoutMs);
});

describe("LM Studio reasoning stream (disabled hint)", () => {
  it.skipIf(smokeEnabled)("set LLM_SMOKE=1 to run live reasoning-stream tests", () => {
    expect(smokeEnabled).toBe(false);
  });
});
