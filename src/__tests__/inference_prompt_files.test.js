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
import { _internal, initializeInferencePanel } from "../inference_panel.js";

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

  it("opens a .prompt file into the system prompt textarea", async () => {
    const starter = readFileSync(defaultPromptPath, "utf8");
    vi.mocked(api.openFile).mockResolvedValue(starter);

    await initializeInferencePanel();
    await _internal.onPromptOpen();

    expect(api.openFile).toHaveBeenCalledWith("/tmp/starter.prompt");
    expect(document.getElementById("inference-system-prompt").value).toBe(starter);
    expect(_internal.getCurrentPromptPath()).toBe("/tmp/starter.prompt");
    expect(api.saveSettings).toHaveBeenCalled();
  });

  it("save as confirms overwrite when file already exists", async () => {
    await initializeInferencePanel();
    document.getElementById("inference-system-prompt").value = "Custom prompt text.";

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

    expect(api.saveFile).toHaveBeenCalledWith("/tmp/new.prompt", "Custom prompt text.");
    expect(_internal.getCurrentPromptPath()).toBe("/tmp/new.prompt");
  });

  it("delete clears the prompt and path after confirmation", async () => {
    vi.mocked(api.openFile).mockResolvedValue("To delete.");
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
