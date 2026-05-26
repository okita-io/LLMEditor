// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

import * as api from "../api.js";
import { _internal, initializeInferencePanel } from "../inference_panel.js";

const BASE_SETTINGS = {
  api_url: "http://localhost:1234/v1/chat/completions",
  model: "local-model",
  temperature: 0.5,
  max_tokens: 1024,
  system_prompt: "Be concise.",
  inference_presets: {
    "The Surgical Editor": {
      temperature: 0.1,
      max_tokens: 512,
      system_prompt: "Edit surgically.",
      limit_response_length: true,
      context_overflow_policy: "truncate_middle",
      stop_strings: "",
      top_k: 40,
      repeat_penalty_enabled: true,
      repeat_penalty: 1.1,
      presence_penalty_enabled: false,
      presence_penalty: 0,
      top_p_enabled: true,
      top_p: 0.95,
      min_p_enabled: true,
      min_p: 0.05,
      structured_output_enabled: false,
      structured_output: "",
      reasoning_enabled: true,
    },
  },
  active_inference_preset: "The Surgical Editor",
  reasoning_enabled: true,
};

function setupDom() {
  document.body.innerHTML = '<aside id="inference-panel"></aside>';
}

describe("inference presets", () => {
  beforeEach(() => {
    _internal.resetForTests();
    setupDom();
    api.loadSettings.mockResolvedValue({ ...BASE_SETTINGS });
    api.saveSettings.mockResolvedValue(undefined);
  });

  afterEach(() => {
    _internal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("populates the preset dropdown from settings on init", async () => {
    await initializeInferencePanel();

    const select = document.getElementById("inference-preset-select");
    const nameInput = document.getElementById("inference-preset-name");

    expect(select).not.toBeNull();
    expect(nameInput.value).toBe("The Surgical Editor");
    expect(select.value).toBe("The Surgical Editor");
    expect(Array.from(select.options).some((o) => o.value === "The Surgical Editor")).toBe(true);
  });

  it("loads the selected preset into the inference panel", async () => {
    await initializeInferencePanel();

    document.getElementById("inference-temperature").value = "0.9";
    await _internal.onPresetLoad();

    expect(document.getElementById("inference-temperature").value).toBe("0.1");
    expect(document.getElementById("inference-system-prompt").value).toBe("Edit surgically.");
    expect(api.saveSettings).toHaveBeenCalled();
    const payload = api.saveSettings.mock.calls.at(-1)[0];
    expect(payload.active_inference_preset).toBe("The Surgical Editor");
  });

  it("shows overwrite confirmation when saving an existing preset name", async () => {
    await initializeInferencePanel();

    document.getElementById("inference-preset-name").value = "The Surgical Editor";
    document.getElementById("inference-temperature").value = "0.7";

    const savePromise = _internal.onPresetSave();
    await Promise.resolve();
    expect(api.saveSettings).not.toHaveBeenCalled();

    const modal = document.getElementById("inference-confirm-modal");
    expect(modal.hidden).toBe(false);
    modal.querySelector('[data-action="confirm"]').click();
    await savePromise;

    expect(api.saveSettings).toHaveBeenCalled();
    const payload = api.saveSettings.mock.calls.at(-1)[0];
    expect(payload.inference_presets["The Surgical Editor"].temperature).toBe(0.7);
  });

  it("deletes a preset after confirmation", async () => {
    await initializeInferencePanel();

    document.getElementById("inference-preset-select").value = "The Surgical Editor";

    const deletePromise = _internal.onPresetDelete();
    await Promise.resolve();

    const modal = document.getElementById("inference-confirm-modal");
    modal.querySelector('[data-action="confirm"]').click();
    await deletePromise;

    const payload = api.saveSettings.mock.calls.at(-1)[0];
    expect(payload.inference_presets["The Surgical Editor"]).toBeUndefined();
    expect(payload.active_inference_preset).toBe("");
  });

  it("sorts preset names alphabetically", () => {
    expect(
      _internal.sortedPresetNames({
        zebra: {},
        alpha: {},
        Beta: {},
      })
    ).toEqual(["alpha", "Beta", "zebra"]);
  });

  describe("reasoning row capability gating", () => {
    it("renders the reasoning row as unsupported when no capability is reported", async () => {
      await initializeInferencePanel();
      _internal.setActiveReasoningCapability(null);

      const row = document.querySelector(".inference-row-reasoning");
      const cb = document.getElementById("inference-reasoning-enabled");

      expect(row?.dataset.reasoningState).toBe("unsupported");
      expect(cb?.disabled).toBe(true);
    });

    it("enables the toggle when the model allows both off and on", async () => {
      await initializeInferencePanel();
      _internal.setActiveReasoningCapability({
        allowed_options: ["off", "on"],
        default: "on",
      });

      const row = document.querySelector(".inference-row-reasoning");
      const cb = document.getElementById("inference-reasoning-enabled");

      expect(cb?.disabled).toBe(false);
      // Default settings have reasoning_enabled=true → row state is "on".
      expect(row?.dataset.reasoningState).toBe("on");
    });

    it("forces the toggle on when the model only allows on", async () => {
      await initializeInferencePanel();
      const cb = document.getElementById("inference-reasoning-enabled");
      cb.checked = false;
      _internal.setActiveReasoningCapability({
        allowed_options: ["on"],
        default: "on",
      });

      const row = document.querySelector(".inference-row-reasoning");
      expect(row?.dataset.reasoningState).toBe("forced-on");
      expect(cb.disabled).toBe(true);
      expect(cb.checked).toBe(true);
    });
  });
});
