// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Inference settings panel — LM Studio sampling and context controls.

import * as api from "./api.js";

/** @type {HTMLElement | null} */
let panelEl = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let saveTimer = null;

/** @type {boolean} */
let suppressSave = false;

const INFERENCE_DEFAULTS = Object.freeze({
  temperature: 0.2,
  max_tokens: 2048,
  system_prompt: "",
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
});

/**
 * @param {string} id
 * @returns {HTMLElement | null}
 */
function $(id) {
  if (!panelEl) return null;
  return panelEl.querySelector(`#${id}`);
}

/**
 * @param {string} id
 * @returns {string}
 */
function inputValue(id) {
  const el = $(id);
  if (!el) return "";
  return typeof el.value === "string" ? el.value : "";
}

/**
 * @param {string} id
 * @param {unknown} value
 */
function setValue(id, value) {
  const el = $(id);
  if (!el) return;
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    el.checked = Boolean(value);
    return;
  }
  el.value = value == null ? "" : String(value);
}

/**
 * @param {string} id
 * @param {boolean} disabled
 */
function setDisabled(id, disabled) {
  const el = $(id);
  if (el) el.disabled = disabled;
}

/**
 * @returns {Record<string, unknown>}
 */
function readInferenceValues() {
  return {
    system_prompt: inputValue("inference-system-prompt"),
    temperature: Number(inputValue("inference-temperature")),
    limit_response_length: Boolean($("inference-limit-length")?.checked),
    max_tokens: Number(inputValue("inference-max-tokens")),
    context_overflow_policy: inputValue("inference-context-overflow"),
    stop_strings: inputValue("inference-stop-strings"),
    top_k: Number(inputValue("inference-top-k")),
    repeat_penalty_enabled: Boolean($("inference-repeat-penalty-enabled")?.checked),
    repeat_penalty: Number(inputValue("inference-repeat-penalty")),
    presence_penalty_enabled: Boolean($("inference-presence-penalty-enabled")?.checked),
    presence_penalty: Number(inputValue("inference-presence-penalty")),
    top_p_enabled: Boolean($("inference-top-p-enabled")?.checked),
    top_p: Number(inputValue("inference-top-p")),
    min_p_enabled: Boolean($("inference-min-p-enabled")?.checked),
    min_p: Number(inputValue("inference-min-p")),
    structured_output_enabled: Boolean($("inference-structured-output-enabled")?.checked),
    structured_output: inputValue("inference-structured-output"),
  };
}

/**
 * @param {object} settings
 */
function applySettingsToPanel(settings) {
  suppressSave = true;
  const merged = { ...INFERENCE_DEFAULTS, ...(settings || {}) };
  setValue("inference-system-prompt", merged.system_prompt);
  setValue("inference-temperature", merged.temperature);
  setValue("inference-limit-length", merged.limit_response_length);
  setValue("inference-max-tokens", merged.max_tokens);
  setValue("inference-context-overflow", merged.context_overflow_policy);
  setValue("inference-stop-strings", merged.stop_strings);
  setValue("inference-top-k", merged.top_k);
  setValue("inference-repeat-penalty-enabled", merged.repeat_penalty_enabled);
  setValue("inference-repeat-penalty", merged.repeat_penalty);
  setValue("inference-presence-penalty-enabled", merged.presence_penalty_enabled);
  setValue("inference-presence-penalty", merged.presence_penalty);
  setValue("inference-top-p-enabled", merged.top_p_enabled);
  setValue("inference-top-p", merged.top_p);
  setValue("inference-min-p-enabled", merged.min_p_enabled);
  setValue("inference-min-p", merged.min_p);
  setValue("inference-structured-output-enabled", merged.structured_output_enabled);
  setValue("inference-structured-output", merged.structured_output);
  syncDependentFields();
  suppressSave = false;
}

/**
 * @returns {void}
 */
function syncDependentFields() {
  const limitOn = Boolean($("inference-limit-length")?.checked);
  setDisabled("inference-max-tokens", !limitOn);

  const repeatOn = Boolean($("inference-repeat-penalty-enabled")?.checked);
  setDisabled("inference-repeat-penalty", !repeatOn);

  const presenceOn = Boolean($("inference-presence-penalty-enabled")?.checked);
  setDisabled("inference-presence-penalty", !presenceOn);

  const topPOn = Boolean($("inference-top-p-enabled")?.checked);
  setDisabled("inference-top-p", !topPOn);

  const minPOn = Boolean($("inference-min-p-enabled")?.checked);
  setDisabled("inference-min-p", !minPOn);

  const structuredOn = Boolean($("inference-structured-output-enabled")?.checked);
  setDisabled("inference-structured-output", !structuredOn);
}

/**
 * @returns {Promise<void>}
 */
async function persistInferenceSettings() {
  if (suppressSave) return;
  let current;
  try {
    current = await api.loadSettings();
  } catch {
    current = {};
  }
  const merged = { ...current, ...readInferenceValues() };
  try {
    await api.saveSettings(merged);
    if (typeof document !== "undefined" && typeof CustomEvent === "function") {
      document.dispatchEvent(new CustomEvent("settings:inference-changed"));
    }
  } catch {
    /* silent — values remain in the panel for retry */
  }
}

/**
 * @returns {void}
 */
function scheduleSave() {
  syncDependentFields();
  if (suppressSave) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistInferenceSettings();
  }, 350);
}

/**
 * @param {string} labelText
 * @param {HTMLElement} control
 * @returns {HTMLElement}
 */
function makeRow(labelText, control) {
  const row = document.createElement("div");
  row.className = "inference-row";

  const label = document.createElement("label");
  label.className = "inference-row-label";
  label.textContent = labelText;
  row.appendChild(label);

  const field = document.createElement("div");
  field.className = "inference-row-field";
  field.appendChild(control);
  row.appendChild(field);

  return row;
}

/**
 * @param {string} id
 * @param {boolean} [checked]
 * @returns {HTMLInputElement}
 */
function makeCheckbox(id, checked = false) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.className = "inference-checkbox";
  input.checked = checked;
  input.addEventListener("change", scheduleSave);
  return input;
}

/**
 * @param {string} id
 * @param {string} type
 * @param {Record<string, string>} [attrs]
 * @returns {HTMLInputElement}
 */
function makeInput(id, type, attrs = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.id = id;
  input.className = "inference-input";
  for (const [key, value] of Object.entries(attrs)) {
    input.setAttribute(key, value);
  }
  input.addEventListener("input", scheduleSave);
  input.addEventListener("change", scheduleSave);
  return input;
}

/**
 * @returns {void}
 */
function buildPanelDom() {
  panelEl = document.getElementById("inference-panel");
  if (!panelEl || panelEl.dataset.inferenceBuilt === "1") return;
  panelEl.dataset.inferenceBuilt = "1";

  const scroll = document.createElement("div");
  scroll.className = "inference-scroll";

  const heading = document.createElement("h2");
  heading.className = "inference-heading";
  heading.textContent = "Inference";
  scroll.appendChild(heading);

  const systemPrompt = document.createElement("textarea");
  systemPrompt.id = "inference-system-prompt";
  systemPrompt.className = "inference-textarea inference-system-prompt";
  systemPrompt.rows = 4;
  systemPrompt.placeholder = "Optional system instructions…";
  systemPrompt.spellcheck = false;
  systemPrompt.addEventListener("input", scheduleSave);
  scroll.appendChild(systemPrompt);

  scroll.appendChild(
    makeRow(
      "Temperature",
      makeInput("inference-temperature", "number", {
        min: "0",
        max: "2",
        step: "0.1",
      })
    )
  );

  const limitCheckbox = makeCheckbox("inference-limit-length", true);
  scroll.appendChild(makeRow("Limit Response Length", limitCheckbox));

  scroll.appendChild(
    makeRow(
      "Max Tokens",
      makeInput("inference-max-tokens", "number", {
        min: "1",
        max: "1000000",
        step: "1",
      })
    )
  );

  const overflow = document.createElement("select");
  overflow.id = "inference-context-overflow";
  overflow.className = "inference-select";
  for (const [value, label] of [
    ["truncate_middle", "Truncate Middle"],
    ["rolling_window", "Rolling Window"],
    ["stop_at_limit", "Stop at Limit"],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    overflow.appendChild(opt);
  }
  overflow.addEventListener("change", scheduleSave);
  scroll.appendChild(makeRow("Context Overflow", overflow));

  const stopStrings = document.createElement("input");
  stopStrings.type = "text";
  stopStrings.id = "inference-stop-strings";
  stopStrings.className = "inference-input inference-input-wide";
  stopStrings.placeholder = "Comma-separated stop strings";
  stopStrings.spellcheck = false;
  stopStrings.addEventListener("input", scheduleSave);
  scroll.appendChild(makeRow("Stop Strings", stopStrings));

  scroll.appendChild(
    makeRow(
      "Top K Sampling",
      makeInput("inference-top-k", "number", { min: "0", max: "1000", step: "1" })
    )
  );

  const repeatRow = document.createElement("div");
  repeatRow.className = "inference-row inference-row-toggle";
  const repeatLabel = document.createElement("label");
  repeatLabel.className = "inference-row-label";
  repeatLabel.textContent = "Repeat Penalty";
  repeatRow.appendChild(repeatLabel);
  const repeatField = document.createElement("div");
  repeatField.className = "inference-row-field inference-toggle-value";
  repeatField.appendChild(makeCheckbox("inference-repeat-penalty-enabled", true));
  repeatField.appendChild(
    makeInput("inference-repeat-penalty", "number", {
      min: "0",
      max: "2",
      step: "0.1",
    })
  );
  repeatRow.appendChild(repeatField);
  scroll.appendChild(repeatRow);

  const presenceRow = document.createElement("div");
  presenceRow.className = "inference-row inference-row-toggle";
  const presenceLabel = document.createElement("label");
  presenceLabel.className = "inference-row-label";
  presenceLabel.textContent = "Presence Penalty";
  presenceRow.appendChild(presenceLabel);
  const presenceField = document.createElement("div");
  presenceField.className = "inference-row-field inference-toggle-value";
  presenceField.appendChild(makeCheckbox("inference-presence-penalty-enabled", false));
  presenceField.appendChild(
    makeInput("inference-presence-penalty", "number", {
      min: "-2",
      max: "2",
      step: "0.1",
    })
  );
  presenceRow.appendChild(presenceField);
  scroll.appendChild(presenceRow);

  const topPRow = document.createElement("div");
  topPRow.className = "inference-row inference-row-toggle";
  const topPLabel = document.createElement("label");
  topPLabel.className = "inference-row-label";
  topPLabel.textContent = "Top P Sampling";
  topPRow.appendChild(topPLabel);
  const topPField = document.createElement("div");
  topPField.className = "inference-row-field inference-toggle-value";
  topPField.appendChild(makeCheckbox("inference-top-p-enabled", true));
  topPField.appendChild(
    makeInput("inference-top-p", "number", { min: "0", max: "1", step: "0.01" })
  );
  topPRow.appendChild(topPField);
  scroll.appendChild(topPRow);

  const minPRow = document.createElement("div");
  minPRow.className = "inference-row inference-row-toggle";
  const minPLabel = document.createElement("label");
  minPLabel.className = "inference-row-label";
  minPLabel.textContent = "Min P Sampling";
  minPRow.appendChild(minPLabel);
  const minPField = document.createElement("div");
  minPField.className = "inference-row-field inference-toggle-value";
  minPField.appendChild(makeCheckbox("inference-min-p-enabled", true));
  minPField.appendChild(
    makeInput("inference-min-p", "number", { min: "0", max: "1", step: "0.01" })
  );
  minPRow.appendChild(minPField);
  scroll.appendChild(minPRow);

  const structuredSection = document.createElement("div");
  structuredSection.className = "inference-structured-section";

  const structuredHead = document.createElement("div");
  structuredHead.className = "inference-row inference-row-toggle";
  const structuredLabel = document.createElement("label");
  structuredLabel.className = "inference-row-label";
  structuredLabel.textContent = "Structured Output";
  structuredHead.appendChild(structuredLabel);
  const structuredToggle = document.createElement("div");
  structuredToggle.className = "inference-row-field";
  structuredToggle.appendChild(makeCheckbox("inference-structured-output-enabled", false));
  structuredHead.appendChild(structuredToggle);
  structuredSection.appendChild(structuredHead);

  const structuredText = document.createElement("textarea");
  structuredText.id = "inference-structured-output";
  structuredText.className = "inference-textarea inference-structured-text";
  structuredText.rows = 4;
  structuredText.placeholder = '{"type":"object","properties":{…}}';
  structuredText.spellcheck = false;
  structuredText.disabled = true;
  structuredText.addEventListener("input", scheduleSave);
  structuredSection.appendChild(structuredText);
  scroll.appendChild(structuredSection);

  panelEl.appendChild(scroll);
}

/**
 * @returns {Promise<void>}
 */
export async function initializeInferencePanel() {
  if (typeof document === "undefined") return;
  buildPanelDom();

  let settings;
  try {
    settings = await api.loadSettings();
  } catch {
    settings = null;
  }
  applySettingsToPanel(settings || {});

  if (typeof document !== "undefined") {
    document.addEventListener("settings:model-changed", async () => {
      try {
        applySettingsToPanel(await api.loadSettings());
      } catch {
        /* keep current panel values */
      }
    });
  }
}

/**
 * Reload panel from persisted settings (e.g. after settings modal save).
 *
 * @returns {Promise<void>}
 */
export async function refreshInferencePanel() {
  try {
    applySettingsToPanel(await api.loadSettings());
  } catch {
    applySettingsToPanel({});
  }
}

export const _internal = {
  readInferenceValues,
  applySettingsToPanel,
  INFERENCE_DEFAULTS,
};
