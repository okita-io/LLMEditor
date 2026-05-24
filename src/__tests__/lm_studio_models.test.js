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

  it("requests /api/v1/models and returns sorted unique model ids", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }],
      }),
    }));

    const models = await fetchLmStudioModels(
      "http://localhost:1234/v1/chat/completions"
    );
    expect(models).toEqual(["a-model", "z-model"]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:1234/api/v1/models",
      { method: "GET", headers: { Accept: "application/json" } }
    );
  });

  it("falls back to /v1/models when /api/v1/models returns 404", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: "legacy-model" }] }),
      });

    const models = await fetchLmStudioModels(
      "http://localhost:1234/v1/chat/completions"
    );
    expect(models).toEqual(["legacy-model"]);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:1234/api/v1/models",
      { method: "GET", headers: { Accept: "application/json" } }
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      lmStudioLegacyModelsUrl("http://localhost:1234/v1/chat/completions"),
      { method: "GET", headers: { Accept: "application/json" } }
    );
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
