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
  deleteFile: vi.fn(),
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

describe("inference prompt files", () => {
  beforeEach(() => {
    _internal.resetForTests();
    setupDom();
    api.loadSettings.mockResolvedValue({ ...BASE_SETTINGS });
    api.saveSettings.mockResolvedValue(undefined);
    api.openFile.mockReset();
    api.saveFile.mockReset();
    api.deleteFile.mockReset();
    _internal.setPromptDialogOverrides({
      open: async () => "/tmp/starter.prompt",
      save: async () => "/tmp/new.prompt",
    });
  });

  afterEach(() => {
    _internal.resetForTests();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("builds Open, Save, and Save as controls above the system prompt", async () => {
    await initializeInferencePanel();

    expect(document.getElementById("inference-prompt-open")).not.toBeNull();
    expect(document.getElementById("inference-prompt-save")).not.toBeNull();
    expect(document.getElementById("inference-prompt-save-as")).not.toBeNull();
    expect(document.getElementById("inference-system-prompt")).not.toBeNull();
  });

  it("opens a JSON .prompt file into the full inference panel", async () => {
    const starter = readFileSync(defaultPromptPath, "utf8");
    vi.mocked(api.openFile).mockResolvedValue(starter);

    await initializeInferencePanel();
    await _internal.onPromptOpen();

    const expected = parsePromptFileContents(starter).settings;
    expect(api.openFile).toHaveBeenCalledWith("/tmp/starter.prompt");
    expect(document.getElementById("inference-system-prompt").value).toBe(expected.system_prompt);
    expect(Number(document.getElementById("inference-temperature").value)).toBe(
      expected.temperature
    );
    expect(Number(document.getElementById("inference-max-tokens").value)).toBe(
      expected.max_tokens
    );
    expect(document.getElementById("inference-structured-output").value).toBe("");
    expect(_internal.getCurrentPromptPath()).toBe("/tmp/starter.prompt");
    expect(api.saveSettings).toHaveBeenCalled();
  });

  it("opens legacy plain-text .prompt files into the system prompt only", async () => {
    vi.mocked(api.openFile).mockResolvedValue("Legacy plain prompt.");

    await initializeInferencePanel();
    document.getElementById("inference-temperature").value = "0.9";
    await _internal.loadPromptFile("/tmp/legacy.prompt");

    expect(document.getElementById("inference-system-prompt").value).toBe("Legacy plain prompt.");
    expect(document.getElementById("inference-temperature").value).toBe("0.9");
  });

  it("save as writes JSON with inference fields and empty structured_output when disabled", async () => {
    await initializeInferencePanel();
    document.getElementById("inference-system-prompt").value = "Custom prompt text.";
    document.getElementById("inference-temperature").value = "0.4";
    document.getElementById("inference-structured-output-enabled").checked = false;
    document.getElementById("inference-structured-output").value = "should be cleared";

    vi.mocked(api.openFile).mockImplementation(async (path) => {
      if (path === "/tmp/new.prompt") return "existing";
      throw new Error("missing");
    });

    const savePromise = _internal.onPromptSaveAs();
    await vi.waitFor(() => {
      const modal = document.getElementById("inference-confirm-modal");
      expect(modal).not.toBeNull();
      expect(modal.hidden).toBe(false);
    });
    document.getElementById("inference-confirm-modal").querySelector('[data-action="confirm"]').click();
    await savePromise;

    const saved = vi.mocked(api.saveFile).mock.calls[0][1];
    const parsed = JSON.parse(saved);
    expect(parsed.format_version).toBe(1);
    expect(parsed.system_prompt).toBe("Custom prompt text.");
    expect(parsed.temperature).toBe(0.4);
    expect(parsed.structured_output_enabled).toBe(false);
    expect(parsed.structured_output).toBe("");
    expect(serializePromptFileContents(_internal.readInferenceValues())).toBe(saved);
    expect(api.saveFile).toHaveBeenCalledWith("/tmp/new.prompt", saved);
    expect(_internal.getCurrentPromptPath()).toBe("/tmp/new.prompt");
  });

  it("delete clears the prompt and path after confirmation", async () => {
    vi.mocked(api.openFile).mockResolvedValue(readFileSync(defaultPromptPath, "utf8"));
    await initializeInferencePanel();
    await _internal.loadPromptFile("/tmp/starter.prompt");

    const deletePromise = _internal.onPromptDelete();
    await Promise.resolve();
    document.getElementById("inference-confirm-modal").querySelector('[data-action="confirm"]').click();
    await deletePromise;

    expect(api.deleteFile).toHaveBeenCalledWith("/tmp/starter.prompt");
    expect(document.getElementById("inference-system-prompt").value).toBe("");
    expect(_internal.getCurrentPromptPath()).toBeNull();
  });
});
