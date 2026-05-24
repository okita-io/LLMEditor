// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — settings_modal.js
//
// Owns the Settings_Modal lifecycle: open with the current settings
// pre-populated (Req 11.1), per-field inline validation matching the
// backend's bounds (Req 11.4-11.7), persist via `api.saveSettings` on
// Save (Req 11.3), keep the modal open and surface the failure if the
// backend rejects the write (Req 11.9), and close-without-write on
// Cancel or Escape (Req 11.8).
//
// Public surface used by `menu.js` and `main.js`:
//   - open()           — build DOM lazily, pre-populate from
//                         api.loadSettings(), focus first input.
//   - close()          — hide the modal and discard in-modal edits.
//   - isModalOpen()    — boolean; menu.js consults this for Req 3.6
//                         and Escape gating (Req 11.8).
//   - validateField    — per-field validator used by Save and unit
//                         tests; returns { ok: true } | { ok: false,
//                         reason }.
//   - validateAll      — whole-form validator; returns { ok: true,
//                         values } | { ok: false, errors: Map }.
//
// The validators are kept in sync with `Settings::validate_field` in
// `src-tauri/src/settings.rs` for every field except `max_tokens`,
// which the modal validates against the Req 11.5 bound `[1, 1_000_000]`
// rather than the backend's wider Req 10.2 bound `[1, 1_048_576]`.
// Per the design notes, the modal's range is a strict subset of the
// backend's, so any value the modal accepts the backend will also
// accept; the disparity exists because Req 11.5 explicitly states the
// modal upper bound as one million.
//
// Modal DOM is built lazily on the first `open()` call and reused on
// subsequent opens; this keeps the bootstrap fast (Req 1.1) and avoids
// rebuilding HTML on every menu invocation. The modal element itself
// uses the `hidden` attribute as the source of truth for visibility,
// which matches the CSS rule `.modal[hidden] { display: none; }`.
//
// References:
// - design.md: "settings_modal.js — modal lifecycle + validation".
// - Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9.

import * as api from "./api.js";
import * as editor from "./editor.js";
import { fetchLmStudioModels } from "./lm_studio_models.js";

/* -------------------------------------------------------------------- */
/* Validation bounds (mirror Rust `Settings::validate_field`).          */
/* -------------------------------------------------------------------- */

/** Inclusive minimum length of `api_url` in Unicode code points. */
const API_URL_MIN_CHARS = 1;
/** Inclusive maximum length of `api_url` in Unicode code points. */
const API_URL_MAX_CHARS = 2048;

/** Inclusive minimum length of `model` in Unicode code points. */
const MODEL_MIN_CHARS = 1;
/** Inclusive maximum length of `model` in Unicode code points. */
const MODEL_MAX_CHARS = 256;

/** Inclusive minimum value of `temperature` (Req 11.4). */
const TEMPERATURE_MIN = 0.0;
/** Inclusive maximum value of `temperature` (Req 11.4). */
const TEMPERATURE_MAX = 2.0;

/** Inclusive minimum value of `max_tokens` (Req 11.5). */
const MAX_TOKENS_MIN = 1;
/** Inclusive maximum value of `max_tokens` (Req 11.5). */
const MAX_TOKENS_MAX = 1_000_000;

/** Inclusive maximum length of `system_prompt` in Unicode code points. */
const SYSTEM_PROMPT_MAX_CHARS = 32_768;

/** Allowed values for `replace_mode` (Req 11.2, mirror Req 10.3). */
const REPLACE_MODE_VALUES = Object.freeze([
  "insert_at_cursor",
  "replace_selection",
  "replace_document",
]);

/** Allowed values for `tab_spaces`. */
const TAB_SPACES_VALUES = Object.freeze([2, 4]);

/** Default settings used when `loadSettings()` rejects on open. */
const FALLBACK_DEFAULTS = Object.freeze({
  api_url: "http://localhost:1234/v1/chat/completions",
  model: "local-model",
  temperature: 0.2,
  max_tokens: 2048,
  replace_mode: "replace_document",
  system_prompt: "",
  tab_spaces: 4,
});

/* -------------------------------------------------------------------- */
/* Module state.                                                         */
/* -------------------------------------------------------------------- */

let modalEl = null;
let isOpen = false;

/* -------------------------------------------------------------------- */
/* Validators.                                                           */
/* -------------------------------------------------------------------- */

/**
 * Count the Unicode code points in `s`.
 *
 * The backend's bounds are measured in code points (chars().count() in
 * Rust), so we use the same unit here. `[...s].length` walks the string
 * via the @@iterator, which yields one element per code point and
 * collapses surrogate pairs.
 *
 * @param {string} s
 * @returns {number}
 */
function codePointLength(s) {
  if (typeof s !== "string" || s.length === 0) return 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      let count = 0;
      // eslint-disable-next-line no-unused-vars
      for (const _ of s) count += 1;
      return count;
    }
  }
  return s.length;
}

/**
 * Tiny pure-JS scheme-prefix check, mirroring the Rust
 * `is_http_or_https_url`. The string passes iff it begins with
 * `"http://"` or `"https://"` AND the portion after the scheme is
 * non-empty. Case-sensitive on purpose, matching the backend.
 *
 * @param {string} s
 * @returns {boolean}
 */
function isHttpOrHttpsUrl(s) {
  if (typeof s !== "string") return false;
  if (s.startsWith("https://")) return s.length > "https://".length;
  if (s.startsWith("http://")) return s.length > "http://".length;
  return false;
}

/**
 * Validate a single field by name + raw value coming straight from a
 * form input (so all values are typically strings).
 *
 * @param {string} name
 * @param {unknown} rawValue
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function validateField(name, rawValue) {
  switch (name) {
    case "api_url": {
      if (typeof rawValue !== "string") {
        return { ok: false, reason: "must be a string" };
      }
      const len = codePointLength(rawValue);
      if (len < API_URL_MIN_CHARS) {
        return { ok: false, reason: "must not be empty" };
      }
      if (len > API_URL_MAX_CHARS) {
        return {
          ok: false,
          reason: `must be at most ${API_URL_MAX_CHARS} characters`,
        };
      }
      if (!isHttpOrHttpsUrl(rawValue)) {
        return {
          ok: false,
          reason: "must be an absolute URL with scheme http:// or https://",
        };
      }
      return { ok: true, value: rawValue };
    }
    case "model": {
      if (typeof rawValue !== "string") {
        return { ok: false, reason: "must be a string" };
      }
      const len = codePointLength(rawValue);
      if (len < MODEL_MIN_CHARS) {
        return { ok: false, reason: "must not be empty" };
      }
      if (len > MODEL_MAX_CHARS) {
        return {
          ok: false,
          reason: `must be at most ${MODEL_MAX_CHARS} characters`,
        };
      }
      return { ok: true, value: rawValue };
    }
    case "temperature": {
      // The form input is `type="number"`, but its `.value` is still a
      // string. We accept both strings (for unit tests that read raw
      // values) and finite numbers. Empty strings and non-numeric
      // strings fail the "must be a number" check.
      let num;
      if (typeof rawValue === "number") {
        num = rawValue;
      } else if (typeof rawValue === "string") {
        if (rawValue.trim().length === 0) {
          return { ok: false, reason: "must be a number" };
        }
        num = Number(rawValue);
      } else {
        return { ok: false, reason: "must be a number" };
      }
      if (!Number.isFinite(num)) {
        return { ok: false, reason: "must be a finite number" };
      }
      if (num < TEMPERATURE_MIN || num > TEMPERATURE_MAX) {
        return {
          ok: false,
          reason: `must be between ${TEMPERATURE_MIN.toFixed(1)} and ${TEMPERATURE_MAX.toFixed(1)}`,
        };
      }
      return { ok: true, value: num };
    }
    case "max_tokens": {
      let num;
      if (typeof rawValue === "number") {
        num = rawValue;
      } else if (typeof rawValue === "string") {
        if (rawValue.trim().length === 0) {
          return { ok: false, reason: "must be an integer" };
        }
        num = Number(rawValue);
      } else {
        return { ok: false, reason: "must be an integer" };
      }
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        return { ok: false, reason: "must be an integer" };
      }
      if (num < MAX_TOKENS_MIN || num > MAX_TOKENS_MAX) {
        return {
          ok: false,
          reason: `must be an integer between ${MAX_TOKENS_MIN} and ${MAX_TOKENS_MAX}`,
        };
      }
      return { ok: true, value: num };
    }
    case "replace_mode": {
      if (typeof rawValue !== "string" || !REPLACE_MODE_VALUES.includes(rawValue)) {
        return {
          ok: false,
          reason: `must be one of ${REPLACE_MODE_VALUES.join(", ")}`,
        };
      }
      return { ok: true, value: rawValue };
    }
    case "system_prompt": {
      if (typeof rawValue !== "string") {
        return { ok: false, reason: "must be a string" };
      }
      const len = codePointLength(rawValue);
      if (len > SYSTEM_PROMPT_MAX_CHARS) {
        return {
          ok: false,
          reason: `must be at most ${SYSTEM_PROMPT_MAX_CHARS} characters`,
        };
      }
      return { ok: true, value: rawValue };
    }
    case "tab_spaces": {
      let num;
      if (typeof rawValue === "number") {
        num = rawValue;
      } else if (typeof rawValue === "string") {
        if (rawValue.trim().length === 0) {
          return { ok: false, reason: "must be 2 or 4" };
        }
        num = Number(rawValue);
      } else {
        return { ok: false, reason: "must be 2 or 4" };
      }
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        return { ok: false, reason: "must be 2 or 4" };
      }
      if (!TAB_SPACES_VALUES.includes(num)) {
        return { ok: false, reason: "must be 2 or 4" };
      }
      return { ok: true, value: num };
    }
    default:
      return { ok: false, reason: "unknown settings field" };
  }
}

/**
 * Validate every field of a candidate settings object. On success the
 * returned `values` is a fresh, normalized object suitable for handing
 * to `api.saveSettings` (numeric fields are coerced to numbers, and
 * unknown extra keys are dropped). On failure `errors` is a Map keyed
 * by field name.
 *
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, values: object } | { ok: false, errors: Map<string, string> }}
 */
export function validateAll(input) {
  const errors = new Map();
  const values = {};
  for (const field of [
    "api_url",
    "model",
    "temperature",
    "max_tokens",
    "replace_mode",
    "system_prompt",
    "tab_spaces",
  ]) {
    const result = validateField(field, input ? input[field] : undefined);
    if (result.ok) {
      values[field] = result.value;
    } else {
      errors.set(field, result.reason);
    }
  }
  if (errors.size > 0) {
    return { ok: false, errors };
  }
  return { ok: true, values };
}

/* -------------------------------------------------------------------- */
/* DOM construction.                                                     */
/* -------------------------------------------------------------------- */

/**
 * Build the modal DOM and attach it to `document.body` if it has not
 * been built yet. Subsequent calls are no-ops; the same element is
 * reused across opens.
 *
 * The structure mirrors the markup in design.md / Task 23 and uses the
 * `hidden` attribute as the source of truth for visibility (CSS rule:
 * `.modal[hidden] { display: none; }`).
 *
 * @returns {HTMLElement} the modal root
 */
function ensureModalBuilt() {
  if (modalEl && document.body.contains(modalEl)) {
    return modalEl;
  }

  const root = document.createElement("div");
  root.id = "settings-modal";
  root.className = "modal";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.hidden = true;

  const content = document.createElement("div");
  content.className = "modal-content";
  root.appendChild(content);

  const heading = document.createElement("h2");
  heading.textContent = "AI Settings";
  content.appendChild(heading);

  const form = document.createElement("form");
  form.setAttribute("novalidate", "");
  content.appendChild(form);

  // Helper to append a labeled input row plus its inline-error span.
  const addField = (id, fieldName, labelText, inputBuilder) => {
    const label = document.createElement("label");
    label.append(`${labelText} `);
    const input = inputBuilder();
    input.id = id;
    input.name = fieldName;
    label.appendChild(input);
    form.appendChild(label);

    const err = document.createElement("span");
    err.className = "field-error";
    err.dataset.field = fieldName;
    form.appendChild(err);

    return input;
  };

  addField("settings-api-url", "api_url", "API URL", () => {
    const i = document.createElement("input");
    i.type = "url";
    return i;
  });

  const modelLabel = document.createElement("label");
  modelLabel.textContent = "Model ";
  const modelRow = document.createElement("div");
  modelRow.className = "settings-model-row";

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.id = "settings-model";
  modelInput.name = "model";
  modelRow.appendChild(modelInput);

  const fetchModelsBtn = document.createElement("button");
  fetchModelsBtn.type = "button";
  fetchModelsBtn.id = "settings-fetch-models";
  fetchModelsBtn.className = "settings-fetch-models-btn";
  fetchModelsBtn.textContent = "Load models";
  fetchModelsBtn.addEventListener("click", () => {
    void onFetchModels();
  });
  modelRow.appendChild(fetchModelsBtn);

  modelLabel.appendChild(modelRow);

  const modelPicker = document.createElement("select");
  modelPicker.id = "settings-model-picker";
  modelPicker.className = "settings-model-picker";
  modelPicker.hidden = true;
  const modelPickerPlaceholder = document.createElement("option");
  modelPickerPlaceholder.value = "";
  modelPickerPlaceholder.textContent = "Select a model…";
  modelPicker.appendChild(modelPickerPlaceholder);
  modelPicker.addEventListener("change", () => {
    if (modelPicker.value.length > 0) {
      setInputValue("settings-model", modelPicker.value);
      setFieldError("model", "");
    }
  });
  modelLabel.appendChild(modelPicker);

  form.appendChild(modelLabel);

  const modelErr = document.createElement("span");
  modelErr.className = "field-error";
  modelErr.dataset.field = "model";
  form.appendChild(modelErr);

  addField("settings-temperature", "temperature", "Temperature", () => {
    const i = document.createElement("input");
    i.type = "number";
    i.step = "0.1";
    i.min = "0";
    i.max = "2";
    return i;
  });

  addField("settings-max-tokens", "max_tokens", "Max Tokens", () => {
    const i = document.createElement("input");
    i.type = "number";
    i.step = "1";
    i.min = String(MAX_TOKENS_MIN);
    i.max = String(MAX_TOKENS_MAX);
    return i;
  });

  addField("settings-replace-mode", "replace_mode", "Replace Mode", () => {
    const sel = document.createElement("select");
    for (const value of REPLACE_MODE_VALUES) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = replaceModeLabel(value);
      sel.appendChild(opt);
    }
    return sel;
  });

  addField("settings-tab-spaces", "tab_spaces", "Tab → Spaces", () => {
    const sel = document.createElement("select");
    for (const value of TAB_SPACES_VALUES) {
      const opt = document.createElement("option");
      opt.value = String(value);
      opt.textContent = `${value} spaces`;
      sel.appendChild(opt);
    }
    return sel;
  });

  addField("settings-system-prompt", "system_prompt", "System Prompt", () => {
    return document.createElement("textarea");
  });

  // Footer with modal-level error span and the two buttons.
  const footer = document.createElement("div");
  footer.className = "modal-footer";

  const modalError = document.createElement("span");
  modalError.className = "modal-error";
  footer.appendChild(modalError);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    close();
  });
  footer.appendChild(cancelBtn);

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.dataset.action = "save";
  saveBtn.textContent = "Save";
  footer.appendChild(saveBtn);

  form.appendChild(footer);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void onSubmit();
  });

  // Defense-in-depth Escape handler. The canonical Escape gating
  // lives in `menu.js` (it consults `isModalOpen()` first), but a
  // local listener guards against the case where the document-level
  // listener has been torn down (e.g. in unit tests that re-import
  // menu.js). The handler only fires when the modal is open.
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      close();
    }
  });

  document.body.appendChild(root);
  modalEl = root;
  return root;
}

/**
 * Human-friendly label for each `replace_mode` option.
 *
 * @param {string} value
 * @returns {string}
 */
function replaceModeLabel(value) {
  switch (value) {
    case "insert_at_cursor":
      return "Insert at Cursor";
    case "replace_selection":
      return "Replace Selection";
    case "replace_document":
      return "Replace Document";
    default:
      return value;
  }
}

/* -------------------------------------------------------------------- */
/* Field helpers.                                                        */
/* -------------------------------------------------------------------- */

/**
 * Read every field's raw form value into a plain object keyed by
 * field name. Numeric inputs return strings (HTMLInputElement.value);
 * `validateField` handles the coercion.
 *
 * @returns {Record<string, string>}
 */
function readFormValues() {
  if (!modalEl) return {};
  return {
    api_url: getInputValue("settings-api-url"),
    model: getInputValue("settings-model"),
    temperature: getInputValue("settings-temperature"),
    max_tokens: getInputValue("settings-max-tokens"),
    replace_mode: getInputValue("settings-replace-mode"),
    system_prompt: getInputValue("settings-system-prompt"),
    tab_spaces: getInputValue("settings-tab-spaces"),
  };
}

/**
 * Read the `.value` of a form control by id, returning the empty
 * string when the control is missing or has no value.
 *
 * @param {string} id
 * @returns {string}
 */
function getInputValue(id) {
  if (!modalEl) return "";
  const el = modalEl.querySelector(`#${id}`);
  if (!el) return "";
  return typeof el.value === "string" ? el.value : "";
}

/**
 * Write `value` into the form control with id `id`. Coerces non-string
 * values to strings so number inputs receive `"0.2"` rather than `0.2`.
 *
 * @param {string} id
 * @param {unknown} value
 */
function setInputValue(id, value) {
  if (!modalEl) return;
  const el = modalEl.querySelector(`#${id}`);
  if (!el) return;
  el.value = value == null ? "" : String(value);
}

/**
 * Pre-populate every modal field from `settings`. Missing or
 * unrecognized fields fall back to `FALLBACK_DEFAULTS`.
 *
 * @param {object} settings
 */
function applySettingsToForm(settings) {
  const merged = { ...FALLBACK_DEFAULTS, ...(settings || {}) };
  setInputValue("settings-api-url", merged.api_url);
  setInputValue("settings-model", merged.model);
  setInputValue("settings-temperature", merged.temperature);
  setInputValue("settings-max-tokens", merged.max_tokens);
  // Replace mode falls back to a known-valid option if the loaded
  // value is outside the allowed set; keeps the <select> in a
  // selectable state even with corrupt input.
  const rmode = REPLACE_MODE_VALUES.includes(merged.replace_mode)
    ? merged.replace_mode
    : FALLBACK_DEFAULTS.replace_mode;
  setInputValue("settings-replace-mode", rmode);
  const tabSpaces = TAB_SPACES_VALUES.includes(Number(merged.tab_spaces))
    ? merged.tab_spaces
    : FALLBACK_DEFAULTS.tab_spaces;
  setInputValue("settings-tab-spaces", tabSpaces);
  setInputValue("settings-system-prompt", merged.system_prompt);
}

function setFieldError(field, text) {
  if (!modalEl) return;
  const span = modalEl.querySelector(`.field-error[data-field="${field}"]`);
  if (span) span.textContent = typeof text === "string" ? text : "";
}

/**
 * Hide and reset the model picker dropdown.
 *
 * @returns {void}
 */
function resetModelPicker() {
  if (!modalEl) return;
  const picker = modalEl.querySelector("#settings-model-picker");
  if (!picker) return;
  picker.hidden = true;
  picker.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a model…";
  picker.appendChild(placeholder);
  picker.value = "";
}

/**
 * Populate the model picker from LM Studio and show it.
 *
 * @param {string[]} modelIds
 * @returns {void}
 */
function showModelPicker(modelIds) {
  if (!modalEl) return;
  const picker = modalEl.querySelector("#settings-model-picker");
  if (!picker) return;

  resetModelPicker();
  const current = getInputValue("settings-model");

  for (const id of modelIds) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    picker.appendChild(opt);
  }

  picker.hidden = false;
  if (current.length > 0 && modelIds.includes(current)) {
    picker.value = current;
  }
}

/**
 * Request available models from the configured API URL and populate
 * the model picker.
 *
 * @returns {Promise<void>}
 */
async function onFetchModels() {
  if (!modalEl) return;

  const fetchBtn = modalEl.querySelector("#settings-fetch-models");
  const apiUrl = getInputValue("settings-api-url");
  const apiCheck = validateField("api_url", apiUrl);
  if (!apiCheck.ok) {
    setFieldError("api_url", apiCheck.reason);
    return;
  }

  setFieldError("model", "");
  if (fetchBtn) {
    fetchBtn.disabled = true;
    fetchBtn.textContent = "Loading…";
  }

  try {
    const models = await fetchLmStudioModels(apiUrl);
    showModelPicker(models);
  } catch (err) {
    resetModelPicker();
    const reason =
      err && typeof err === "object" && "message" in err
        ? String(err.message)
        : String(err);
    setFieldError("model", reason);
  } finally {
    if (fetchBtn) {
      fetchBtn.disabled = false;
      fetchBtn.textContent = "Load models";
    }
  }
}

/**
 * Clear every per-field inline error span and the modal-footer error.
 */
function clearFieldErrors() {
  if (!modalEl) return;
  const spans = modalEl.querySelectorAll(".field-error");
  for (const s of spans) s.textContent = "";
  setModalError("");
}

/**
 * Set or clear the modal-footer error span (used for save failures
 * per Req 11.9).
 *
 * @param {string} text
 */
function setModalError(text) {
  if (!modalEl) return;
  const el = modalEl.querySelector(".modal-error");
  if (el) el.textContent = typeof text === "string" ? text : "";
}

/**
 * Render per-field error messages. `errors` is a Map keyed by field
 * name, as returned by `validateAll`.
 *
 * @param {Map<string, string>} errors
 */
function renderFieldErrors(errors) {
  if (!modalEl) return;
  for (const [field, reason] of errors) {
    const span = modalEl.querySelector(
      `.field-error[data-field="${field}"]`
    );
    if (span) span.textContent = reason;
  }
}

/* -------------------------------------------------------------------- */
/* Submit handler.                                                       */
/* -------------------------------------------------------------------- */

/**
 * Form-submit handler invoked by the Save button. Runs `validateAll`
 * across the live form values; on validation failure renders the
 * per-field errors and aborts (Req 11.4-11.7). On success calls
 * `api.saveSettings(values)`. Save success closes the modal
 * (Req 11.3); save failure keeps it open with the failure reason in
 * the modal footer and the in-modal edits preserved (Req 11.9).
 *
 * @returns {Promise<void>}
 */
async function onSubmit() {
  if (!modalEl) return;
  clearFieldErrors();

  const raw = readFormValues();
  const result = validateAll(raw);
  if (!result.ok) {
    renderFieldErrors(result.errors);
    return;
  }

  try {
    await api.saveSettings(result.values);
    editor.applyEditorSettings(result.values);
    close();
  } catch (err) {
    // Req 11.9: keep the modal open, surface the failure in the
    // footer error span, and leave every input value intact.
    const reason =
      err && typeof err === "object" && "message" in err
        ? String(err.message)
        : String(err);
    setModalError(reason);
  }
}

/* -------------------------------------------------------------------- */
/* Public surface.                                                       */
/* -------------------------------------------------------------------- */

/**
 * Open the Settings_Modal, pre-populating every input from the
 * currently cached settings (Req 11.1). If `loadSettings()` rejects,
 * the modal still opens populated with the documented defaults and
 * the load error is shown in the modal footer so the user can edit
 * and save without needing to dismiss any extra dialog.
 *
 * Idempotent: re-calling while open is a no-op so a stray
 * shortcut/click cannot reset the in-modal edits mid-edit.
 *
 * @returns {Promise<void>}
 */
export async function open() {
  if (typeof document === "undefined") {
    isOpen = true;
    return;
  }
  if (isOpen) return;

  ensureModalBuilt();
  clearFieldErrors();
  resetModelPicker();

  let loaded;
  let loadError = null;
  try {
    loaded = await api.loadSettings();
  } catch (err) {
    loaded = null;
    loadError =
      err && typeof err === "object" && "message" in err
        ? String(err.message)
        : String(err);
  }

  applySettingsToForm(loaded || {});
  if (loadError) setModalError(loadError);

  modalEl.hidden = false;
  isOpen = true;

  // Move focus to the first input so keyboard users land inside the
  // form on open. Wrapped in try/catch because not every test DOM
  // implements `.focus`.
  try {
    const first = modalEl.querySelector("#settings-api-url");
    if (first && typeof first.focus === "function") first.focus();
  } catch {
    /* ignore — focus is a UX nicety, not a correctness invariant */
  }
}

/**
 * Close the modal without writing to the Settings_Store (Req 11.8).
 * In-modal edits are discarded — they are not copied anywhere outside
 * the form's input values, so simply hiding the modal and clearing
 * inline errors is sufficient. The next `open()` call will re-populate
 * every field from `loadSettings()`, overwriting any leftover values.
 */
export function close() {
  if (!isOpen) return;
  isOpen = false;
  if (modalEl) {
    modalEl.hidden = true;
    clearFieldErrors();
  }
}

/**
 * @returns {boolean} `true` while the modal is on screen.
 */
export function isModalOpen() {
  return isOpen;
}

/* -------------------------------------------------------------------- */
/* Test-only hooks.                                                      */
/* -------------------------------------------------------------------- */

/**
 * Test-only escape hatches. The `_` prefix flags these as private
 * helpers used by `settings_modal.test.js` to reset module state
 * between cases.
 */
export const _internal = {
  bounds: Object.freeze({
    API_URL_MIN_CHARS,
    API_URL_MAX_CHARS,
    MODEL_MIN_CHARS,
    MODEL_MAX_CHARS,
    TEMPERATURE_MIN,
    TEMPERATURE_MAX,
    MAX_TOKENS_MIN,
    MAX_TOKENS_MAX,
    SYSTEM_PROMPT_MAX_CHARS,
    REPLACE_MODE_VALUES,
  }),
  isHttpOrHttpsUrl,
  codePointLength,
  /** Reset module-level state for tests that need a clean slate. */
  reset() {
    isOpen = false;
    if (modalEl && modalEl.parentNode) {
      modalEl.parentNode.removeChild(modalEl);
    }
    modalEl = null;
  },
};
