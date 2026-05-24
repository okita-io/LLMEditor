// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — lm_studio_models.js edge case tests.
//
// Covers:
//   - URL parsing edge cases
//   - Timeout behavior
//   - Empty/malformed API URL handling
//   - Response parsing edge cases

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchLmStudioModels,
  lmStudioBaseUrl,
  lmStudioModelsUrl,
  lmStudioLegacyModelsUrl,
} from "../lm_studio_models.js";

describe("lmStudioBaseUrl — edge cases", () => {
  it("returns empty string for empty input", () => {
    expect(lmStudioBaseUrl("")).toBe("");
  });

  it("returns empty string for null", () => {
    expect(lmStudioBaseUrl(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(lmStudioBaseUrl(undefined)).toBe("");
  });

  it("strips trailing slashes", () => {
    expect(lmStudioBaseUrl("http://localhost:1234///")).toBe("http://localhost:1234");
  });

  it("handles /api/v1 suffix", () => {
    expect(lmStudioBaseUrl("http://localhost:1234/api/v1")).toBe(
      "http://localhost:1234"
    );
  });

  it("handles /v1 suffix", () => {
    expect(lmStudioBaseUrl("http://localhost:1234/v1")).toBe(
      "http://localhost:1234"
    );
  });

  it("handles URL with no recognized suffix", () => {
    expect(lmStudioBaseUrl("http://localhost:1234/custom/path")).toBe(
      "http://localhost:1234/custom/path"
    );
  });

  it("handles whitespace-padded input", () => {
    expect(
      lmStudioBaseUrl("  http://localhost:1234/v1/chat/completions  ")
    ).toBe("http://localhost:1234");
  });
});

describe("lmStudioModelsUrl — edge cases", () => {
  it("returns empty string for empty input", () => {
    expect(lmStudioModelsUrl("")).toBe("");
  });

  it("returns empty string for null", () => {
    expect(lmStudioModelsUrl(null)).toBe("");
  });

  it("returns the URL unchanged if it already ends with /api/v1/models", () => {
    expect(lmStudioModelsUrl("http://localhost:1234/api/v1/models")).toBe(
      "http://localhost:1234/api/v1/models"
    );
  });

  it("constructs from a bare origin", () => {
    expect(lmStudioModelsUrl("http://localhost:1234")).toBe(
      "http://localhost:1234/api/v1/models"
    );
  });

  it("handles non-standard ports", () => {
    expect(lmStudioModelsUrl("http://192.168.1.100:8080/v1/chat/completions")).toBe(
      "http://192.168.1.100:8080/api/v1/models"
    );
  });
});

describe("lmStudioLegacyModelsUrl", () => {
  it("returns /v1/models path", () => {
    expect(
      lmStudioLegacyModelsUrl("http://localhost:1234/v1/chat/completions")
    ).toBe("http://localhost:1234/v1/models");
  });

  it("returns empty string for empty input", () => {
    expect(lmStudioLegacyModelsUrl("")).toBe("");
  });
});

describe("fetchLmStudioModels — edge cases", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws for empty API URL", async () => {
    await expect(fetchLmStudioModels("")).rejects.toThrow("API URL is required");
  });

  it("throws for whitespace-only API URL", async () => {
    await expect(fetchLmStudioModels("   ")).rejects.toThrow("API URL is required");
  });

  it("deduplicates model ids", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "model-a" },
          { id: "model-a" },
          { id: "model-b" },
          { id: "model-b" },
          { id: "model-b" },
        ],
      }),
    }));

    const models = await fetchLmStudioModels("http://localhost:1234/v1/chat/completions");
    expect(models).toEqual(["model-a", "model-b"]);
  });

  it("skips entries with empty or non-string ids", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "" },
          { id: "   " },
          { id: null },
          { id: 42 },
          { id: "valid-model" },
          {},
          null,
        ],
      }),
    }));

    const models = await fetchLmStudioModels("http://localhost:1234/v1/chat/completions");
    expect(models).toEqual(["valid-model"]);
  });

  it("throws when response body has no data array", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: ["a"] }), // wrong shape
    }));

    await expect(
      fetchLmStudioModels("http://localhost:1234/v1/chat/completions")
    ).rejects.toThrow("no models");
  });

  it("sorts model ids alphabetically", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "zebra" }, { id: "alpha" }, { id: "middle" }],
      }),
    }));

    const models = await fetchLmStudioModels("http://localhost:1234/v1/chat/completions");
    expect(models).toEqual(["alpha", "middle", "zebra"]);
  });

  it("falls back to /api/v1/models when /v1/models fails with non-404", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes("/v1/models") && !url.includes("/api/")) {
        throw new Error("connection refused");
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: "fallback" }] }),
      };
    });

    const models = await fetchLmStudioModels(
      "http://localhost:1234/v1/chat/completions"
    );
    expect(models).toEqual(["fallback"]);
  });

  it("respects custom timeout", async () => {
    let timedOut = false;
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve({ ok: true, json: async () => ({ data: [{ id: "m" }] }) });
          }, 5000);
        })
    );

    await expect(
      fetchLmStudioModels("http://localhost:1234/v1/chat/completions", {
        timeoutMs: 50,
      })
    ).rejects.toThrow("timed out");

    expect(timedOut).toBe(false);
  });
});
