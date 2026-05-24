// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchLmStudioModels,
  lmStudioBaseUrl,
  lmStudioLegacyModelsUrl,
  lmStudioModelsUrl,
} from "../lm_studio_models.js";

describe("lmStudioBaseUrl", () => {
  it("strips /v1/chat/completions suffix", () => {
    expect(
      lmStudioBaseUrl("http://localhost:1234/v1/chat/completions")
    ).toBe("http://localhost:1234");
  });

  it("strips /api/v1/chat/completions suffix", () => {
    expect(
      lmStudioBaseUrl("http://localhost:1234/api/v1/chat/completions")
    ).toBe("http://localhost:1234");
  });
});

describe("lmStudioModelsUrl", () => {
  it("uses /api/v1/models on the server origin", () => {
    expect(
      lmStudioModelsUrl("http://localhost:1234/v1/chat/completions")
    ).toBe("http://localhost:1234/api/v1/models");
    expect(
      lmStudioModelsUrl("http://10.0.1.5:1234/v1/chat/completions")
    ).toBe("http://10.0.1.5:1234/api/v1/models");
  });
});

describe("fetchLmStudioModels", () => {
  /** @type {typeof fetch} */
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requests /v1/models first (loaded models) and returns sorted unique model ids", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes("/v1/models") && !url.includes("/api/")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    });

    const models = await fetchLmStudioModels(
      "http://localhost:1234/v1/chat/completions"
    );
    expect(models).toEqual(["a-model", "z-model"]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:1234/v1/models",
      { method: "GET", headers: { Accept: "application/json" } }
    );
  });

  it("falls back to /api/v1/models when /v1/models fails", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async (url) => {
        if (url.includes("/v1/models") && !url.includes("/api/")) {
          return { ok: false, status: 404 };
        }
        return {
          ok: true,
          json: async () => ({ data: [{ id: "fallback-model" }] }),
        };
      });

    const models = await fetchLmStudioModels(
      "http://localhost:1234/v1/chat/completions"
    );
    expect(models).toEqual(["fallback-model"]);
  });

  it("throws when HTTP status is not ok", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }));

    await expect(
      fetchLmStudioModels("http://localhost:1234/v1/chat/completions")
    ).rejects.toThrow("HTTP 503");
  });

  it("throws when no models are returned", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    }));

    await expect(
      fetchLmStudioModels("http://localhost:1234/v1/chat/completions")
    ).rejects.toThrow("no models");
  });
});
