// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  openFile: vi.fn(),
  saveFile: vi.fn(),
}));

import * as api from "../api.js";
import {
  _internal,
  initializeInferencePanel,
  parsePromptFileContents,
  serializePromptFileContents,
} from "../inference_panel.js";

const defaultPromptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../default.prompt"
);

const BASE_SETTINGS = {
  api_url: "http://localhost:1234/v1/chat/completions",
  model: "local-model",
  temperature: 0.2,
  max_tokens: 2048,
  system_prompt: "",
  inference_presets: {},
  active_inference_preset: "",
  reasoning_enabled: true,
};

function setupDom() {
  document.body.innerHTML = '<aside id="inference-panel"></aside>';
}

describe("inference panel layout", () => {
  beforeEach(() => {
    _internal.resetForTests();
    setupDom();
    api.loadSettings.mockResolvedValue({ ...BASE_SETTINGS });
    api.saveSettings.mockResolvedValue(undefined);
    api.openFile.mockReset();
    api.saveFile.mockReset();
    _internal.setPromptDialogOverrides({
      open: async () => "/tmp/starter.prompt",
      save: async () => "/tmp/export.prompt",
    });
  });

  afterEach(() => {
    _internal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("builds Open, Load, Save, Save as, Export, and Delete preset controls", async () => {
    await initializeInferencePanel();

    expect(document.getElementById("inference-preset-open")).not.toBeNull();
    expect(document.getElementById("inference-preset-load")).not.toBeNull();
    expect(document.getElementById("inference-preset-save")).not.toBeNull();
    expect(document.getElementById("inference-preset-save-as")).not.toBeNull();
    expect(document.getElementById("inference-preset-export")).not.toBeNull();
    expect(document.getElementById("inference-preset-delete")).not.toBeNull();
    expect(document.getElementById("inference-system-prompt")).not.toBeNull();
  });

  it("parses default.prompt JSON for full inference settings", () => {
    const starter = readFileSync(defaultPromptPath, "utf8");
    const parsed = parsePromptFileContents(starter);
    expect(parsed).not.toBeNull();
    expect(parsed.settings.system_prompt).toBeTruthy();
    expect(typeof parsed.settings.temperature).toBe("number");
    expect(typeof parsed.settings.max_tokens).toBe("number");
  });

  it("rejects legacy plain-text prompt files", () => {
    expect(parsePromptFileContents("Legacy plain prompt.")).toBeNull();
  });

  it("Open imports a file into the panel and adds a named preset", async () => {
    const starter = readFileSync(defaultPromptPath, "utf8");
    vi.mocked(api.openFile).mockResolvedValue(starter);

    await initializeInferencePanel();
    await _internal.onPresetOpen();

    const expected = parsePromptFileContents(starter).settings;
    expect(document.getElementById("inference-preset-select").value).toBe("starter");
    expect(document.getElementById("inference-preset-name").value).toBe("starter");
    expect(document.getElementById("inference-system-prompt").value).toBe(expected.system_prompt);
    expect(api.saveSettings).toHaveBeenCalled();
    const payload = api.saveSettings.mock.calls.at(-1)[0];
    expect(payload.inference_presets.starter).toBeDefined();
    expect(payload.active_inference_preset).toBe("starter");
  });

  it("Export writes JSON from the panel to disk", async () => {
    await initializeInferencePanel();
    document.getElementById("inference-system-prompt").value = "Export me.";
    document.getElementById("inference-temperature").value = "0.55";

    vi.mocked(api.openFile).mockImplementation(async (path) => {
      if (path === "/tmp/export.prompt") return "existing";
      throw new Error("missing");
    });

    const exportPromise = _internal.onPresetExport();
    await vi.waitFor(() => {
      const modal = document.getElementById("inference-confirm-modal");
      expect(modal).not.toBeNull();
      expect(modal.hidden).toBe(false);
    });
    document.getElementById("inference-confirm-modal").querySelector('[data-action="confirm"]').click();
    await exportPromise;

    const saved = vi.mocked(api.saveFile).mock.calls[0][1];
    const parsed = JSON.parse(saved);
    expect(parsed.system_prompt).toBe("Export me.");
    expect(parsed.temperature).toBe(0.55);
    expect(serializePromptFileContents(_internal.readInferenceValues())).toBe(saved);
    expect(api.saveFile).toHaveBeenCalledWith("/tmp/export.prompt", saved);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
});
