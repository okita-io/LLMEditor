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

const PRESET_NAME_MAX_CHARS = 128;
const PROMPT_FILE_EXT = ".prompt";

/** @type {1} */
const PROMPT_FILE_FORMAT_VERSION = 1;

/** @type {(() => Promise<string|null>) | null} */
let openPromptDialogOverride = null;

/** @type {(() => Promise<string|null>) | null} */
let savePromptDialogOverride = null;

/** @type {ReadonlySet<string>} */
const CONTEXT_OVERFLOW_POLICIES = new Set([
  "truncate_middle",
  "rolling_window",
  "stop_at_limit",
]);

/** @type {string} */
let loadedPresetName = "";

/** @type {HTMLElement | null} */
let confirmModalEl = null;

/** @type {(() => void) | null} */
let confirmModalOnConfirm = null;

const INFERENCE_DEFAULTS = Object.freeze({
  temperature: 0.2,
  seed: 0,
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
  reasoning_enabled: true,
});

/**
 * Latest reasoning capability for the active model, surfaced by
 * `chat.js` via the `model:capabilities-changed` CustomEvent. `null`
 * means the model does not support reasoning (or no model is loaded
 * yet) and the checkbox renders muted/disabled.
 *
 * @type {{ allowed_options: string[], default: string | null } | null}
 */
let activeReasoningCapability = null;

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
    seed: Math.max(0, Math.trunc(Number(inputValue("inference-seed")) || 0)),
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
    reasoning_enabled: Boolean($("inference-reasoning-enabled")?.checked),
  };
}

/**
 * Coerce a loaded `.prompt` JSON object into panel-ready inference values.
 *
 * @param {Record<string, unknown>} data
 * @returns {Record<string, unknown>}
 */
function normalizePromptFileSettings(data) {
  const out = { ...INFERENCE_DEFAULTS };

  if (typeof data.system_prompt === "string") {
    out.system_prompt = data.system_prompt;
  }
  if (typeof data.temperature === "number" && Number.isFinite(data.temperature)) {
    out.temperature = data.temperature;
  }
  if (typeof data.seed === "number" && Number.isFinite(data.seed)) {
    out.seed = Math.max(0, Math.trunc(data.seed));
  }
  if (typeof data.limit_response_length === "boolean") {
    out.limit_response_length = data.limit_response_length;
  }
  if (typeof data.max_tokens === "number" && Number.isFinite(data.max_tokens)) {
    out.max_tokens = Math.max(1, Math.trunc(data.max_tokens));
  }
  if (
    typeof data.context_overflow_policy === "string" &&
    CONTEXT_OVERFLOW_POLICIES.has(data.context_overflow_policy)
  ) {
    out.context_overflow_policy = data.context_overflow_policy;
  }
  if (typeof data.stop_strings === "string") {
    out.stop_strings = data.stop_strings;
  }
  if (typeof data.top_k === "number" && Number.isFinite(data.top_k)) {
    out.top_k = Math.max(0, Math.trunc(data.top_k));
  }
  if (typeof data.repeat_penalty_enabled === "boolean") {
    out.repeat_penalty_enabled = data.repeat_penalty_enabled;
  }
  if (typeof data.repeat_penalty === "number" && Number.isFinite(data.repeat_penalty)) {
    out.repeat_penalty = data.repeat_penalty;
  }
  if (typeof data.presence_penalty_enabled === "boolean") {
    out.presence_penalty_enabled = data.presence_penalty_enabled;
  }
  if (typeof data.presence_penalty === "number" && Number.isFinite(data.presence_penalty)) {
    out.presence_penalty = data.presence_penalty;
  }
  if (typeof data.top_p_enabled === "boolean") {
    out.top_p_enabled = data.top_p_enabled;
  }
  if (typeof data.top_p === "number" && Number.isFinite(data.top_p)) {
    out.top_p = data.top_p;
  }
  if (typeof data.min_p_enabled === "boolean") {
    out.min_p_enabled = data.min_p_enabled;
  }
  if (typeof data.min_p === "number" && Number.isFinite(data.min_p)) {
    out.min_p = data.min_p;
  }
  if (typeof data.structured_output_enabled === "boolean") {
    out.structured_output_enabled = data.structured_output_enabled;
  }
  if (typeof data.structured_output === "string") {
    out.structured_output = data.structured_output;
  }
  if (typeof data.reasoning_enabled === "boolean") {
    out.reasoning_enabled = data.reasoning_enabled;
  }

  if (!out.structured_output_enabled) {
    out.structured_output = "";
  }

  return out;
}

/**
 * @param {string} raw
 * @returns {{ format: "json", settings: Record<string, unknown> } | null}
 */
export function parsePromptFileContents(raw) {
  const text = typeof raw === "string" ? raw : "";
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const data = /** @type {Record<string, unknown>} */ (parsed);
  const looksLikePromptFile =
    data.format_version === PROMPT_FILE_FORMAT_VERSION ||
    "temperature" in data ||
    "max_tokens" in data ||
    "limit_response_length" in data;

  if (!looksLikePromptFile) {
    return null;
  }

  return { format: "json", settings: normalizePromptFileSettings(data) };
}

/**
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
export function serializePromptFileContents(values) {
  const merged = normalizePromptFileSettings({ ...INFERENCE_DEFAULTS, ...values });
  const payload = {
    format_version: PROMPT_FILE_FORMAT_VERSION,
    system_prompt: merged.system_prompt,
    temperature: merged.temperature,
    seed: merged.seed,
    limit_response_length: merged.limit_response_length,
    max_tokens: merged.max_tokens,
    context_overflow_policy: merged.context_overflow_policy,
    stop_strings: merged.stop_strings,
    top_k: merged.top_k,
    repeat_penalty_enabled: merged.repeat_penalty_enabled,
    repeat_penalty: merged.repeat_penalty,
    presence_penalty_enabled: merged.presence_penalty_enabled,
    presence_penalty: merged.presence_penalty,
    top_p_enabled: merged.top_p_enabled,
    top_p: merged.top_p,
    min_p_enabled: merged.min_p_enabled,
    min_p: merged.min_p,
    structured_output_enabled: merged.structured_output_enabled,
    structured_output: merged.structured_output,
    reasoning_enabled: merged.reasoning_enabled,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * @param {object} settings
 */
function applySettingsToPanel(settings) {
  suppressSave = true;
  const merged = { ...INFERENCE_DEFAULTS, ...(settings || {}) };
  setValue("inference-system-prompt", merged.system_prompt);
  setValue("inference-temperature", merged.temperature);
  setValue("inference-seed", merged.seed);
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
  setValue("inference-reasoning-enabled", merged.reasoning_enabled);
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

  syncReasoningRowState();
}

/**
 * Update the Reasoning checkbox to reflect the active model's
 * capability. When the model does not expose `capabilities.reasoning`
 * the row goes muted and the checkbox is disabled. When the model
 * supports it but only allows `["on"]` we force the checkbox checked
 * and disable it (the user can't turn reasoning off on a forced-on
 * model). Otherwise the checkbox is interactive and the row paints
 * green when checked, red when unchecked.
 *
 * @returns {void}
 */
function syncReasoningRowState() {
  const row = panelEl ? panelEl.querySelector(".inference-row-reasoning") : null;
  const cb = $("inference-reasoning-enabled");
  if (!row || !cb) return;

  const cap = activeReasoningCapability;
  const supported = cap !== null;
  const allowed = supported ? cap.allowed_options : [];
  const canDisable = allowed.includes("off");

  if (!supported) {
    cb.disabled = true;
    row.dataset.reasoningState = "unsupported";
    row.title = "Active model does not expose reasoning capability.";
    return;
  }

  if (!canDisable) {
    if (!cb.checked) {
      const prevSuppress = suppressSave;
      suppressSave = true;
      cb.checked = true;
      suppressSave = prevSuppress;
    }
    cb.disabled = true;
    row.dataset.reasoningState = "forced-on";
    row.title = "Active model always reasons (cannot be disabled).";
    return;
  }

  cb.disabled = false;
  row.dataset.reasoningState = cb.checked ? "on" : "off";
  row.title = cb.checked
    ? "Reasoning is on — click to disable."
    : "Reasoning is off — click to enable.";
}

/**
 * Update the cached reasoning capability for the active model and
 * refresh the panel UI. Called by `chat.js` when the model picker
 * changes.
 *
 * @param {{ allowed_options: string[], default: string | null } | null} cap
 */
export function setActiveReasoningCapability(cap) {
  activeReasoningCapability =
    cap && Array.isArray(cap.allowed_options) && cap.allowed_options.length > 0
      ? {
          allowed_options: cap.allowed_options.slice(),
          default: typeof cap.default === "string" ? cap.default : null,
        }
      : null;
  syncReasoningRowState();
}

/**
 * @returns {Record<string, unknown>}
 */
function presetFromInferenceValues() {
  return readInferenceValues();
}

/**
 * @param {string} name
 * @returns {string}
 */
function normalizePresetName(name) {
  return typeof name === "string" ? name.trim() : "";
}

/**
 * @param {Record<string, Record<string, unknown>> | null | undefined} presets
 * @returns {string[]}
 */
function sortedPresetNames(presets) {
  if (!presets || typeof presets !== "object") return [];
  return Object.keys(presets).sort((a, b) => a.localeCompare(b));
}

/**
 * @param {Record<string, Record<string, unknown>> | null | undefined} presets
 * @param {string} [selectedName]
 */
function refreshPresetDropdown(presets, selectedName = "") {
  const select = $("inference-preset-select");
  if (!select) return;

  const names = sortedPresetNames(presets);
  const previous = selectedName || select.value;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = names.length > 0 ? "Select a preset…" : "No presets saved";
  select.appendChild(placeholder);

  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }

  if (previous && names.includes(previous)) {
    select.value = previous;
  } else {
    select.value = "";
  }

  syncPresetActionButtons();
}

/**
 * @returns {void}
 */
function syncPresetActionButtons() {
  const select = $("inference-preset-select");
  const value = select && typeof select.value === "string" ? select.value : "";
  const loadBtn = $("inference-preset-load");
  const saveBtn = $("inference-preset-save");
  const deleteBtn = $("inference-preset-delete");
  const disabled = value.length === 0;
  if (loadBtn) loadBtn.disabled = disabled;
  if (saveBtn) saveBtn.disabled = disabled;
  if (deleteBtn) deleteBtn.disabled = disabled;
}

/**
 * @param {string} name
 */
function setPresetNameField(name) {
  const input = $("inference-preset-name");
  if (input) input.value = name;
  loadedPresetName = name;
}

/**
 * @param {object} settings
 */
function syncPresetControlsFromSettings(settings) {
  const presets =
    settings && typeof settings.inference_presets === "object" && settings.inference_presets
      ? settings.inference_presets
      : {};
  const active =
    settings && typeof settings.active_inference_preset === "string"
      ? settings.active_inference_preset
      : "";
  refreshPresetDropdown(presets, active);
  setPresetNameField(active);
}

/**
 * @returns {Promise<void>}
 */
async function persistSettingsPayload(payload) {
  suppressSave = true;
  try {
    await api.saveSettings(payload);
    syncPresetControlsFromSettings(payload);
    if (typeof document !== "undefined" && typeof CustomEvent === "function") {
      document.dispatchEvent(new CustomEvent("settings:inference-changed"));
    }
  } finally {
    suppressSave = false;
  }
}

/**
 * @param {string} title
 * @param {string} message
 * @param {string} confirmLabel
 * @returns {Promise<boolean>}
 */
export function showConfirmModal(title, message, confirmLabel) {
  if (typeof document === "undefined") return Promise.resolve(false);

  ensureConfirmModalBuilt();
  if (!confirmModalEl) return Promise.resolve(false);

  const heading = confirmModalEl.querySelector(".confirm-modal-title");
  const body = confirmModalEl.querySelector(".confirm-modal-message");
  const confirmBtn = confirmModalEl.querySelector('[data-action="confirm"]');
  if (heading) heading.textContent = title;
  if (body) body.textContent = message;
  if (confirmBtn) confirmBtn.textContent = confirmLabel;

  confirmModalEl.hidden = false;

  return new Promise((resolve) => {
    confirmModalOnConfirm = () => {
      confirmModalEl.hidden = true;
      confirmModalOnConfirm = null;
      resolve(true);
    };

    const onCancel = () => {
      confirmModalEl.hidden = true;
      confirmModalOnConfirm = null;
      resolve(false);
    };

    confirmModalEl.dataset.cancelHandler = "1";
    confirmModalEl._cancelHandler = onCancel;
  });
}

/**
 * @returns {void}
 */
function ensureConfirmModalBuilt() {
  if (confirmModalEl && document.body.contains(confirmModalEl)) return;

  const root = document.createElement("div");
  root.id = "inference-confirm-modal";
  root.className = "modal confirm-modal";
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-modal", "true");
  root.hidden = true;

  const content = document.createElement("div");
  content.className = "modal-content confirm-modal-content";
  root.appendChild(content);

  const heading = document.createElement("h2");
  heading.className = "confirm-modal-title";
  heading.textContent = "Warning";
  content.appendChild(heading);

  const message = document.createElement("p");
  message.className = "confirm-modal-message";
  content.appendChild(message);

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  content.appendChild(footer);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    if (typeof root._cancelHandler === "function") root._cancelHandler();
  });
  footer.appendChild(cancelBtn);

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.dataset.action = "confirm";
  confirmBtn.textContent = "Save";
  confirmBtn.addEventListener("click", () => {
    if (typeof confirmModalOnConfirm === "function") confirmModalOnConfirm();
  });
  footer.appendChild(confirmBtn);

  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !root.hidden && typeof root._cancelHandler === "function") {
      e.preventDefault();
      root._cancelHandler();
    }
  });

  document.body.appendChild(root);
  confirmModalEl = root;
}

/**
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function savePresetByName(name) {
  const trimmed = normalizePresetName(name);
  if (!trimmed) return false;
  if (trimmed.length > PRESET_NAME_MAX_CHARS) return false;

  let current;
  try {
    current = await api.loadSettings();
  } catch {
    current = {};
  }

  const presets = {
    ...(current.inference_presets && typeof current.inference_presets === "object"
      ? current.inference_presets
      : {}),
  };
  presets[trimmed] = presetFromInferenceValues();

  const payload = {
    ...current,
    ...readInferenceValues(),
    inference_presets: presets,
    active_inference_preset: trimmed,
  };

  await persistSettingsPayload(payload);
  setPresetNameField(trimmed);
  refreshPresetDropdown(presets, trimmed);
  return true;
}

/**
 * @returns {Promise<void>}
 */
async function onPresetSave() {
  const select = $("inference-preset-select");
  const name = select && typeof select.value === "string" ? select.value.trim() : "";
  if (!name) return;
  setPresetNameField(name);
  await savePresetByName(name);
}

/**
 * @returns {Promise<void>}
 */
async function onPresetSaveAs() {
  const name = normalizePresetName(inputValue("inference-preset-name"));
  if (!name) return;

  let current;
  try {
    current = await api.loadSettings();
  } catch {
    current = {};
  }

  const presets =
    current.inference_presets && typeof current.inference_presets === "object"
      ? current.inference_presets
      : {};

  if (Object.prototype.hasOwnProperty.call(presets, name)) {
    const confirmed = await showConfirmModal(
      "Warning",
      `There is already a preset using the name "${name}" do you want to overwrite it?`,
      "Save"
    );
    if (!confirmed) return;
  }

  await savePresetByName(name);
}

/**
 * @returns {Promise<void>}
 */
async function onPresetLoad() {
  const select = $("inference-preset-select");
  const name = select && typeof select.value === "string" ? select.value : "";
  if (!name) return;

  let current;
  try {
    current = await api.loadSettings();
  } catch {
    return;
  }

  const presets =
    current.inference_presets && typeof current.inference_presets === "object"
      ? current.inference_presets
      : null;
  const preset = presets ? presets[name] : null;
  if (!preset || typeof preset !== "object") return;

  applySettingsToPanel({ ...INFERENCE_DEFAULTS, ...preset });
  setPresetNameField(name);

  const payload = {
    ...current,
    ...readInferenceValues(),
    active_inference_preset: name,
  };
  await persistSettingsPayload(payload);
}

/**
 * @returns {Promise<void>}
 */
async function onPresetDelete() {
  const select = $("inference-preset-select");
  const name = select && typeof select.value === "string" ? select.value : "";
  if (!name) return;

  const confirmed = await showConfirmModal(
    "Warning",
    `Are you sure you want to delete the preset named "${name}"?`,
    "Delete"
  );
  if (!confirmed) return;

  let current;
  try {
    current = await api.loadSettings();
  } catch {
    return;
  }

  const presets = {
    ...(current.inference_presets && typeof current.inference_presets === "object"
      ? current.inference_presets
      : {}),
  };
  delete presets[name];

  const active =
    current.active_inference_preset === name ? "" : current.active_inference_preset || "";
  const payload = {
    ...current,
    ...readInferenceValues(),
    inference_presets: presets,
    active_inference_preset: active,
  };

  await persistSettingsPayload(payload);
  if (loadedPresetName === name) setPresetNameField("");
  refreshPresetDropdown(presets, active);
}

function basename(path) {
  if (typeof path !== "string" || path.length === 0) return "";
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function ensurePromptExtension(path) {
  if (typeof path !== "string" || path.length === 0) return path;
  const lower = path.toLowerCase();
  return lower.endsWith(PROMPT_FILE_EXT) ? path : `${path}${PROMPT_FILE_EXT}`;
}

/**
 * @param {string} path
 * @returns {string}
 */
function presetNameFromPromptPath(path) {
  const base = basename(path);
  if (!base) return "";
  const lower = base.toLowerCase();
  if (lower.endsWith(PROMPT_FILE_EXT)) {
    return base.slice(0, base.length - PROMPT_FILE_EXT.length);
  }
  return base;
}

async function pathExists(path) {
  try {
    await api.openFile(path);
    return true;
  } catch {
    return false;
  }
}

async function invokePromptOpenDialog() {
  if (typeof openPromptDialogOverride === "function") {
    return await openPromptDialogOverride();
  }
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.dialog || typeof tauri.dialog.open !== "function") {
    return null;
  }
  const result = await tauri.dialog.open({
    multiple: false,
    filters: [
      { name: "LLIMEdit prompts", extensions: ["prompt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return result.length > 0 ? result[0] : null;
  return typeof result === "string" ? result : null;
}

async function invokePromptSaveDialog() {
  if (typeof savePromptDialogOverride === "function") {
    return await savePromptDialogOverride();
  }
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.dialog || typeof tauri.dialog.save !== "function") {
    return null;
  }
  const result = await tauri.dialog.save({
    filters: [
      { name: "LLIMEdit prompts", extensions: ["prompt"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result === null || result === undefined) return null;
  return typeof result === "string" ? result : null;
}

/**
 * Open a `.prompt` file, apply it to the panel, and register it as a preset.
 *
 * @returns {Promise<void>}
 */
async function onPresetOpen() {
  const picked = await invokePromptOpenDialog();
  if (!picked) return;

  let contents;
  try {
    contents = await api.openFile(picked);
  } catch {
    return;
  }

  const parsed = parsePromptFileContents(contents);
  if (!parsed) return;

  const name = normalizePresetName(presetNameFromPromptPath(picked));
  if (!name || name.length > PRESET_NAME_MAX_CHARS) return;

  applySettingsToPanel(parsed.settings);
  setPresetNameField(name);

  let current;
  try {
    current = await api.loadSettings();
  } catch {
    current = {};
  }

  const presets = {
    ...(current.inference_presets && typeof current.inference_presets === "object"
      ? current.inference_presets
      : {}),
  };

  if (Object.prototype.hasOwnProperty.call(presets, name)) {
    const confirmed = await showConfirmModal(
      "Warning",
      `There is already a preset using the name "${name}" do you want to overwrite it?`,
      "Open"
    );
    if (!confirmed) return;
  }

  presets[name] = presetFromInferenceValues();

  const payload = {
    ...current,
    ...readInferenceValues(),
    inference_presets: presets,
    active_inference_preset: name,
  };

  await persistSettingsPayload(payload);
  refreshPresetDropdown(presets, name);
}

/**
 * Export the current panel values to a `.prompt` JSON file on disk.
 *
 * @returns {Promise<void>}
 */
async function onPresetExport() {
  let picked = await invokePromptSaveDialog();
  if (!picked) return;
  picked = ensurePromptExtension(picked);

  if (await pathExists(picked)) {
    const confirmed = await showConfirmModal(
      "Warning",
      `There is already a file named "${basename(picked)}" do you want to overwrite it?`,
      "Export"
    );
    if (!confirmed) return;
  }

  const contents = serializePromptFileContents(readInferenceValues());
  await api.saveFile(picked, contents);
}

/**
 * @returns {HTMLElement}
 */
function buildPresetsSection() {
  const section = document.createElement("section");
  section.className = "inference-presets-section";
  section.setAttribute("aria-label", "Inference presets");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "inference-preset-name";
  nameInput.className = "inference-preset-name";
  nameInput.placeholder = "Preset name";
  nameInput.spellcheck = false;
  nameInput.maxLength = PRESET_NAME_MAX_CHARS;
  section.appendChild(nameInput);

  const select = document.createElement("select");
  select.id = "inference-preset-select";
  select.className = "inference-preset-select";
  select.addEventListener("change", () => {
    const value = select.value;
    if (value) setPresetNameField(value);
    syncPresetActionButtons();
  });
  section.appendChild(select);

  const controls = document.createElement("div");
  controls.className = "inference-preset-controls";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.id = "inference-preset-open";
  openBtn.className = "inference-preset-btn inference-preset-btn-primary";
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", () => {
    void onPresetOpen();
  });
  controls.appendChild(openBtn);

  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.id = "inference-preset-load";
  loadBtn.className = "inference-preset-btn inference-preset-btn-primary";
  loadBtn.textContent = "Load";
  loadBtn.disabled = true;
  loadBtn.addEventListener("click", () => {
    void onPresetLoad();
  });
  controls.appendChild(loadBtn);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.id = "inference-preset-save";
  saveBtn.className = "inference-preset-btn inference-preset-btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.disabled = true;
  saveBtn.addEventListener("click", () => {
    void onPresetSave();
  });
  controls.appendChild(saveBtn);

  const saveAsBtn = document.createElement("button");
  saveAsBtn.type = "button";
  saveAsBtn.id = "inference-preset-save-as";
  saveAsBtn.className = "inference-preset-btn inference-preset-btn-primary";
  saveAsBtn.textContent = "Save as...";
  saveAsBtn.addEventListener("click", () => {
    void onPresetSaveAs();
  });
  controls.appendChild(saveAsBtn);

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.id = "inference-preset-export";
  exportBtn.className = "inference-preset-btn inference-preset-btn-primary";
  exportBtn.textContent = "Export";
  exportBtn.addEventListener("click", () => {
    void onPresetExport();
  });
  controls.appendChild(exportBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.id = "inference-preset-delete";
  deleteBtn.className = "inference-preset-btn inference-preset-btn-danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.disabled = true;
  deleteBtn.addEventListener("click", () => {
    void onPresetDelete();
  });
  controls.appendChild(deleteBtn);

  section.appendChild(controls);
  return section;
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

  scroll.appendChild(buildPresetsSection());

  const systemPrompt = document.createElement("textarea");
  systemPrompt.id = "inference-system-prompt";
  systemPrompt.className = "inference-textarea inference-system-prompt";
  systemPrompt.rows = 8;
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

  scroll.appendChild(
    makeRow(
      "Seed (0 = random)",
      makeInput("inference-seed", "number", {
        min: "0",
        step: "1",
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

  const reasoningRow = document.createElement("div");
  reasoningRow.className = "inference-row inference-row-toggle inference-row-reasoning";
  reasoningRow.dataset.reasoningState = "unsupported";
  const reasoningLabel = document.createElement("label");
  reasoningLabel.className = "inference-row-label";
  reasoningLabel.textContent = "Reasoning";
  reasoningRow.appendChild(reasoningLabel);
  const reasoningField = document.createElement("div");
  reasoningField.className = "inference-row-field inference-toggle-value";
  const reasoningCb = makeCheckbox("inference-reasoning-enabled", true);
  reasoningCb.disabled = true;
  reasoningField.appendChild(reasoningCb);
  reasoningRow.appendChild(reasoningField);
  scroll.appendChild(reasoningRow);

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
  syncPresetControlsFromSettings(settings || {});

  if (typeof document !== "undefined") {
    document.addEventListener("settings:model-changed", async () => {
      try {
        const next = await api.loadSettings();
        applySettingsToPanel(next);
        syncPresetControlsFromSettings(next);
      } catch {
        /* keep current panel values */
      }
    });

    document.addEventListener("model:capabilities-changed", (event) => {
      const detail =
        event && typeof event === "object" && "detail" in event ? event.detail : null;
      const reasoning =
        detail && typeof detail === "object" && detail !== null
          ? detail.reasoning ?? null
          : null;
      setActiveReasoningCapability(reasoning);
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
    const settings = await api.loadSettings();
    applySettingsToPanel(settings);
    syncPresetControlsFromSettings(settings);
  } catch {
    applySettingsToPanel({});
    syncPresetControlsFromSettings({});
  }
}

export const _internal = {
  readInferenceValues,
  applySettingsToPanel,
  INFERENCE_DEFAULTS,
  presetFromInferenceValues,
  sortedPresetNames,
  normalizePresetName,
  savePresetByName,
  onPresetOpen,
  onPresetLoad,
  onPresetSave,
  onPresetSaveAs,
  onPresetExport,
  onPresetDelete,
  presetNameFromPromptPath,
  syncPresetActionButtons,
  syncPresetControlsFromSettings,
  setPresetNameField,
  refreshPresetDropdown,
  showConfirmModal,
  ensureConfirmModalBuilt,
  setActiveReasoningCapability,
  getActiveReasoningCapability: () => activeReasoningCapability,
  getLoadedPresetName: () => loadedPresetName,
  parsePromptFileContents,
  serializePromptFileContents,
  normalizePromptFileSettings,
  PROMPT_FILE_FORMAT_VERSION,
  setPromptDialogOverrides(overrides = {}) {
    if (!overrides || typeof overrides !== "object") {
      openPromptDialogOverride = null;
      savePromptDialogOverride = null;
      return;
    }
    openPromptDialogOverride = overrides.open || null;
    savePromptDialogOverride = overrides.save || null;
  },
  resetForTests() {
    loadedPresetName = "";
    openPromptDialogOverride = null;
    savePromptDialogOverride = null;
    activeReasoningCapability = null;
    if (confirmModalEl && confirmModalEl.parentNode) {
      confirmModalEl.parentNode.removeChild(confirmModalEl);
    }
    confirmModalEl = null;
    confirmModalOnConfirm = null;
    if (panelEl) {
      delete panelEl.dataset.inferenceBuilt;
      panelEl.replaceChildren();
    }
    panelEl = null;
  },
};
