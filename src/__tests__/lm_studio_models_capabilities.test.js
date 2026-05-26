// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Coverage for LM Studio's per-model capability metadata exposed by
// `/api/v1/models`: vision, trained_for_tool_use, reasoning toggle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyCapabilities,
  fetchLmStudioModelsDetailed,
  parseModelInfoEntry,
} from "../lm_studio_models.js";

describe("emptyCapabilities", () => {
  it("returns the muted-default shape used for unknown models", () => {
    expect(emptyCapabilities()).toEqual({
      vision: false,
      tool_use: false,
      reasoning: null,
    });
  });
});

describe("parseModelInfoEntry", () => {
  it("parses a reasoning-capable LLM with both on/off allowed", () => {
    const info = parseModelInfoEntry({
      type: "llm",
      key: "nvidia/nemotron-3-nano-4b",
      loaded_instances: [{ id: "nvidia/nemotron-3-nano-4b" }],
      capabilities: {
        vision: false,
        trained_for_tool_use: true,
        reasoning: { allowed_options: ["off", "on"], default: "on" },
      },
    });

    expect(info).not.toBeNull();
    expect(info?.id).toBe("nvidia/nemotron-3-nano-4b");
    expect(info?.loaded).toBe(true);
    expect(info?.capabilities.vision).toBe(false);
    expect(info?.capabilities.tool_use).toBe(true);
    expect(info?.capabilities.reasoning).toEqual({
      allowed_options: ["off", "on"],
      default: "on",
    });
  });

  it("treats a vision model without reasoning as reasoning=null", () => {
    const info = parseModelInfoEntry({
      type: "vlm",
      id: "gemma-vl-7b",
      loaded_instances: [],
      capabilities: { vision: true, trained_for_tool_use: false },
    });
    expect(info?.capabilities.reasoning).toBeNull();
    expect(info?.capabilities.vision).toBe(true);
    expect(info?.loaded).toBe(false);
  });

  it("filters embedding models", () => {
    expect(
      parseModelInfoEntry({
        type: "embedding",
        id: "text-embed-1",
      })
    ).toBeNull();
  });

  it("handles legacy openai-compat shape (capabilities as string array, state field)", () => {
    const info = parseModelInfoEntry({
      type: "llm",
      id: "legacy-model",
      state: "loaded",
      capabilities: ["tool_use"],
    });
    expect(info?.loaded).toBe(true);
    expect(info?.capabilities.tool_use).toBe(true);
    expect(info?.capabilities.reasoning).toBeNull();
  });

  it("ignores reasoning with empty allowed_options", () => {
    const info = parseModelInfoEntry({
      type: "llm",
      id: "x",
      capabilities: { reasoning: { allowed_options: [] } },
    });
    expect(info?.capabilities.reasoning).toBeNull();
  });
});

describe("fetchLmStudioModelsDetailed", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("hits /api/v1/models and returns sorted, deduped, embedding-free entries", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      expect(url).toBe("http://localhost:1234/api/v1/models");
      return {
        ok: true,
        json: async () => ({
          models: [
            { type: "llm", key: "z-model", loaded_instances: [] },
            {
              type: "llm",
              key: "a-model",
              loaded_instances: [{ id: "a-model" }],
              capabilities: {
                vision: false,
                trained_for_tool_use: true,
                reasoning: { allowed_options: ["on"], default: "on" },
              },
            },
            { type: "embedding", key: "embed-1" },
            { type: "llm", key: "a-model" },
          ],
        }),
      };
    });

    const models = await fetchLmStudioModelsDetailed(
      "http://localhost:1234/v1/chat/completions"
    );
    expect(models.map((m) => m.id)).toEqual(["a-model", "z-model"]);
    expect(models[0].loaded).toBe(true);
    expect(models[0].capabilities.reasoning?.allowed_options).toEqual(["on"]);
    expect(models[1].loaded).toBe(false);
  });

  it("throws when the HTTP status is not ok", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(
      fetchLmStudioModelsDetailed("http://localhost:1234/v1/chat/completions")
    ).rejects.toThrow("HTTP 500");
  });
});
