// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — settings_modal.js unit tests.
//
// Covers Task 23's surface and the formatting / validation rules in
// Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9:
//   - `open()` builds the modal DOM lazily and pre-populates every
//     field from `api.loadSettings()` (Req 11.1).
//   - `close()` hides the modal and discards in-modal edits (Req 11.8).
//   - Per-field validators reject out-of-bounds values and accept
//     boundary values (Req 11.4-11.7).
//   - Save with all-valid fields invokes `api.saveSettings(values)`
//     and closes the modal (Req 11.3).
//   - Save with invalid fields renders inline errors next to the
//     offending field and does NOT call `api.saveSettings`
//     (Req 11.4-11.7).
//   - Save failure (api rejects) keeps the modal open, surfaces the
//     reason in `.modal-error`, and preserves in-modal edits
//     (Req 11.9).
//   - Cancel button closes without saving (Req 11.8).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../api.js", () => {
  return {
    loadSettings: vi.fn(),
    saveSettings: vi.fn(),
  };
});

import * as api from "../api.js";
import {
  open,
  close,
  isModalOpen,
  validateField,
  validateAll,
  _internal,
} from "../settings_modal.js";

const VALID_SETTINGS = Object.freeze({
  api_url: "http://localhost:1234/v1/chat/completions",
  model: "local-model",
  temperature: 0.2,
  max_tokens: 2048,
  replace_mode: "replace_document",
  system_prompt: "",
  tab_spaces: 4,
});

beforeEach(() => {
  document.body.innerHTML = "";
  _internal.reset();
  api.loadSettings.mockReset();
  api.saveSettings.mockReset();
  api.loadSettings.mockResolvedValue({ ...VALID_SETTINGS });
  api.saveSettings.mockResolvedValue(undefined);
});

afterEach(() => {
  _internal.reset();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/**
 * Read the value of a form input by id. Returns the empty string when
 * the input is not present.
 */
function inputValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

/**
 * Set the value of a form input by id and dispatch a `change` event so
 * any wired listeners observe the update. Used to simulate user edits
 * inside the modal.
 */
function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`input #${id} not found`);
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Submit the modal form, returning a promise that resolves after the
 * submit handler completes. Vitest's `await` cycle gives the handler's
 * `await api.saveSettings(...)` a chance to settle.
 */
async function submitForm() {
  const form = document.querySelector("#settings-modal form");
  if (!form) throw new Error("modal form not present in DOM");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  // Yield twice: once for the synchronous submit handler, once for
  // the `await api.saveSettings(...)` microtask.
  await Promise.resolve();
  await Promise.resolve();
}

/* -------------------- validateField (boundary table) ----------------- */

describe("validateField — temperature (Req 11.4)", () => {
  it("accepts the lower endpoint 0.0", () => {
    expect(validateField("temperature", 0.0)).toEqual({ ok: true, value: 0.0 });
    expect(validateField("temperature", "0")).toEqual({ ok: true, value: 0 });
  });

  it("accepts the upper endpoint 2.0", () => {
    expect(validateField("temperature", 2.0)).toEqual({ ok: true, value: 2.0 });
    expect(validateField("temperature", "2")).toEqual({ ok: true, value: 2 });
  });

  it("accepts a midpoint 0.7", () => {
    expect(validateField("temperature", 0.7)).toEqual({ ok: true, value: 0.7 });
  });

  it("rejects -0.1 (below lower bound)", () => {
    const r = validateField("temperature", -0.1);
    expect(r.ok).toBe(false);
  });

  it("rejects 2.1 (above upper bound)", () => {
    const r = validateField("temperature", 2.1);
    expect(r.ok).toBe(false);
  });

  it("rejects NaN and infinities", () => {
    expect(validateField("temperature", Number.NaN).ok).toBe(false);
    expect(validateField("temperature", Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateField("temperature", Number.NEGATIVE_INFINITY).ok).toBe(false);
  });

  it("rejects non-numeric strings and empty strings", () => {
    expect(validateField("temperature", "abc").ok).toBe(false);
    expect(validateField("temperature", "").ok).toBe(false);
    expect(validateField("temperature", "   ").ok).toBe(false);
  });
});

describe("validateField — max_tokens (Req 11.5)", () => {
  it("accepts the lower endpoint 1", () => {
    expect(validateField("max_tokens", 1)).toEqual({ ok: true, value: 1 });
    expect(validateField("max_tokens", "1")).toEqual({ ok: true, value: 1 });
  });

  it("accepts the upper endpoint 1_000_000", () => {
    expect(validateField("max_tokens", 1_000_000)).toEqual({
      ok: true,
      value: 1_000_000,
    });
    expect(validateField("max_tokens", "1000000")).toEqual({
      ok: true,
      value: 1_000_000,
    });
  });

  it("rejects 0 (below lower bound)", () => {
    expect(validateField("max_tokens", 0).ok).toBe(false);
  });

  it("rejects 1_000_001 (above upper bound)", () => {
    expect(validateField("max_tokens", 1_000_001).ok).toBe(false);
  });

  it("rejects non-integer values", () => {
    expect(validateField("max_tokens", 2048.5).ok).toBe(false);
    expect(validateField("max_tokens", "2048.5").ok).toBe(false);
  });

  it("rejects negative integers", () => {
    expect(validateField("max_tokens", -1).ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(validateField("max_tokens", "").ok).toBe(false);
  });
});

describe("validateField — api_url (Req 11.6)", () => {
  it("accepts http://… URLs", () => {
    expect(validateField("api_url", "http://localhost:1234/v1").ok).toBe(true);
    expect(validateField("api_url", "http://a").ok).toBe(true);
  });

  it("accepts https://… URLs", () => {
    expect(validateField("api_url", "https://example.com/x").ok).toBe(true);
  });

  it("rejects schemes other than http/https", () => {
    expect(validateField("api_url", "ftp://example.com").ok).toBe(false);
    expect(validateField("api_url", "ws://example.com").ok).toBe(false);
    expect(validateField("api_url", "file:///etc/hosts").ok).toBe(false);
  });

  it("rejects bare schemes with no rest", () => {
    expect(validateField("api_url", "http://").ok).toBe(false);
    expect(validateField("api_url", "https://").ok).toBe(false);
  });

  it("rejects schemeless URLs", () => {
    expect(validateField("api_url", "localhost:1234/v1").ok).toBe(false);
    expect(validateField("api_url", "//example.com").ok).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(validateField("api_url", "").ok).toBe(false);
  });

  it("matches the backend's case sensitivity (uppercase scheme rejected)", () => {
    expect(validateField("api_url", "HTTP://example.com").ok).toBe(false);
  });
});

describe("validateField — model (Req 11.7)", () => {
  it("accepts a non-empty model string", () => {
    expect(validateField("model", "local-model").ok).toBe(true);
    expect(validateField("model", "x").ok).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(validateField("model", "").ok).toBe(false);
  });

  it("rejects values longer than 256 code points", () => {
    expect(validateField("model", "x".repeat(257)).ok).toBe(false);
  });

  it("accepts a value at exactly 256 code points", () => {
    expect(validateField("model", "x".repeat(256)).ok).toBe(true);
  });
});

describe("validateField — replace_mode (Req 11.2)", () => {
  it("accepts the three valid values", () => {
    for (const v of ["insert_at_cursor", "replace_selection", "replace_document"]) {
      expect(validateField("replace_mode", v)).toEqual({ ok: true, value: v });
    }
  });

  it("rejects any other value", () => {
    expect(validateField("replace_mode", "").ok).toBe(false);
    expect(validateField("replace_mode", "InsertAtCursor").ok).toBe(false);
    expect(validateField("replace_mode", "replace").ok).toBe(false);
  });
});

describe("validateField — system_prompt", () => {
  it("accepts the empty string", () => {
    expect(validateField("system_prompt", "").ok).toBe(true);
  });

  it("accepts up to 32_768 code points", () => {
    expect(validateField("system_prompt", "x".repeat(32_768)).ok).toBe(true);
  });

  it("rejects 32_769 code points", () => {
    expect(validateField("system_prompt", "x".repeat(32_769)).ok).toBe(false);
  });
});

describe("validateField — tab_spaces", () => {
  it("accepts 2 and 4", () => {
    expect(validateField("tab_spaces", 2)).toEqual({ ok: true, value: 2 });
    expect(validateField("tab_spaces", 4)).toEqual({ ok: true, value: 4 });
    expect(validateField("tab_spaces", "2")).toEqual({ ok: true, value: 2 });
  });

  it("rejects other values", () => {
    expect(validateField("tab_spaces", 0).ok).toBe(false);
    expect(validateField("tab_spaces", 3).ok).toBe(false);
    expect(validateField("tab_spaces", 8).ok).toBe(false);
  });
});

describe("validateAll", () => {
  it("returns the normalized values when every field is valid", () => {
    const r = validateAll({
      api_url: "http://localhost:1234/v1",
      model: "m",
      temperature: "0.5",
      max_tokens: "1024",
      replace_mode: "insert_at_cursor",
      system_prompt: "prompt",
      tab_spaces: "2",
    });
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({
      api_url: "http://localhost:1234/v1",
      model: "m",
      temperature: 0.5,
      max_tokens: 1024,
      replace_mode: "insert_at_cursor",
      system_prompt: "prompt",
      tab_spaces: 2,
    });
  });

  it("collects every offending field into the errors map", () => {
    const r = validateAll({
      api_url: "ftp://nope",
      model: "",
      temperature: 9,
      max_tokens: 0,
      replace_mode: "wrong",
      system_prompt: "x".repeat(32_769),
      tab_spaces: 3,
    });
    expect(r.ok).toBe(false);
    const fields = Array.from(r.errors.keys()).sort();
    expect(fields).toEqual([
      "api_url",
      "max_tokens",
      "model",
      "replace_mode",
      "system_prompt",
      "tab_spaces",
      "temperature",
    ]);
  });
});

/* -------------------- open / close lifecycle (Req 11.1, 11.8) -------- */

describe("open()", () => {
  it("builds the modal DOM lazily on first call (Req 11.2)", async () => {
    expect(document.querySelector("#settings-modal")).toBeNull();

    await open();

    const modal = document.querySelector("#settings-modal");
    expect(modal).not.toBeNull();
    expect(modal.hidden).toBe(false);
    expect(isModalOpen()).toBe(true);
    // Inputs from Req 11.2
    expect(document.querySelector("#settings-api-url")).not.toBeNull();
    expect(document.querySelector("#settings-model")).not.toBeNull();
    expect(document.querySelector("#settings-temperature")).not.toBeNull();
    expect(document.querySelector("#settings-max-tokens")).not.toBeNull();
    expect(document.querySelector("#settings-system-prompt")).not.toBeNull();
    const select = document.querySelector("#settings-replace-mode");
    expect(select).not.toBeNull();
    const opts = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(opts).toEqual([
      "insert_at_cursor",
      "replace_selection",
      "replace_document",
    ]);
    expect(document.querySelector('button[data-action="cancel"]')).not.toBeNull();
    expect(document.querySelector('button[data-action="save"]')).not.toBeNull();
  });

  it("pre-populates every field from api.loadSettings (Req 11.1)", async () => {
    api.loadSettings.mockResolvedValueOnce({
      api_url: "https://api.example.test/v1",
      model: "remote-model",
      temperature: 1.3,
      max_tokens: 5000,
      replace_mode: "insert_at_cursor",
      system_prompt: "Be terse.",
    });

    await open();

    expect(api.loadSettings).toHaveBeenCalledTimes(1);
    expect(inputValue("settings-api-url")).toBe("https://api.example.test/v1");
    expect(inputValue("settings-model")).toBe("remote-model");
    expect(inputValue("settings-temperature")).toBe("1.3");
    expect(inputValue("settings-max-tokens")).toBe("5000");
    expect(inputValue("settings-replace-mode")).toBe("insert_at_cursor");
    expect(inputValue("settings-system-prompt")).toBe("Be terse.");
  });

  it("falls back to defaults and surfaces the load error when loadSettings rejects", async () => {
    api.loadSettings.mockRejectedValueOnce(new Error("config dir denied"));

    await open();

    expect(isModalOpen()).toBe(true);
    expect(inputValue("settings-api-url")).toBe(
      "http://localhost:1234/v1/chat/completions"
    );
    expect(inputValue("settings-model")).toBe("local-model");
    expect(inputValue("settings-replace-mode")).toBe("replace_document");
    const modalErr = document.querySelector(".modal-error");
    expect(modalErr.textContent).toBe("config dir denied");
  });

  it("re-using the modal after close+open does not duplicate the DOM", async () => {
    await open();
    close();
    await open();
    expect(document.querySelectorAll("#settings-modal")).toHaveLength(1);
  });

  it("calling open while already open is a no-op (does not refetch settings)", async () => {
    await open();
    expect(api.loadSettings).toHaveBeenCalledTimes(1);
    setInputValue("settings-model", "user-edited");

    await open();

    expect(api.loadSettings).toHaveBeenCalledTimes(1);
    expect(inputValue("settings-model")).toBe("user-edited");
  });
});

describe("close()", () => {
  it("hides the modal and resets isModalOpen", async () => {
    await open();
    expect(isModalOpen()).toBe(true);

    close();

    expect(isModalOpen()).toBe(false);
    expect(document.querySelector("#settings-modal").hidden).toBe(true);
  });

  it("does not call api.saveSettings (Req 11.8)", async () => {
    await open();
    setInputValue("settings-model", "discarded");

    close();

    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it("on next open re-populates from loadSettings, discarding edits (Req 11.8)", async () => {
    api.loadSettings.mockResolvedValue({ ...VALID_SETTINGS });
    await open();
    setInputValue("settings-model", "discarded");

    close();
    await open();

    expect(inputValue("settings-model")).toBe(VALID_SETTINGS.model);
  });

  it("clears any inline field errors when closing", async () => {
    await open();
    setInputValue("settings-model", "");
    await submitForm();
    const modelErr = document.querySelector(
      '.field-error[data-field="model"]'
    );
    expect(modelErr.textContent.length).toBeGreaterThan(0);

    close();

    expect(modelErr.textContent).toBe("");
  });
});

/* -------------------- Save flow (Req 11.3, 11.4-11.7, 11.9) ---------- */

describe("Save with all-valid fields (Req 11.3)", () => {
  it("calls api.saveSettings with the normalized values and closes", async () => {
    await open();
    setInputValue("settings-api-url", "https://api.example.test/v1");
    setInputValue("settings-model", "remote-model");
    setInputValue("settings-temperature", "0.7");
    setInputValue("settings-max-tokens", "1024");
    setInputValue("settings-replace-mode", "insert_at_cursor");
    setInputValue("settings-system-prompt", "Be terse.");

    await submitForm();

    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(api.saveSettings).toHaveBeenCalledWith({
      api_url: "https://api.example.test/v1",
      model: "remote-model",
      temperature: 0.7,
      max_tokens: 1024,
      replace_mode: "insert_at_cursor",
      system_prompt: "Be terse.",
      tab_spaces: 4,
    });
    expect(isModalOpen()).toBe(false);
    expect(document.querySelector("#settings-modal").hidden).toBe(true);
  });
});

describe("Save with invalid fields (Req 11.4-11.7)", () => {
  it("renders the inline error next to temperature and does NOT save", async () => {
    await open();
    setInputValue("settings-temperature", "9");

    await submitForm();

    expect(api.saveSettings).not.toHaveBeenCalled();
    const span = document.querySelector(
      '.field-error[data-field="temperature"]'
    );
    expect(span.textContent.length).toBeGreaterThan(0);
    expect(isModalOpen()).toBe(true);
  });

  it("renders the inline error next to max_tokens and does NOT save", async () => {
    await open();
    setInputValue("settings-max-tokens", "0");

    await submitForm();

    expect(api.saveSettings).not.toHaveBeenCalled();
    const span = document.querySelector(
      '.field-error[data-field="max_tokens"]'
    );
    expect(span.textContent.length).toBeGreaterThan(0);
  });

  it("renders the inline error next to api_url and does NOT save", async () => {
    await open();
    setInputValue("settings-api-url", "ftp://nope");

    await submitForm();

    expect(api.saveSettings).not.toHaveBeenCalled();
    const span = document.querySelector(
      '.field-error[data-field="api_url"]'
    );
    expect(span.textContent.length).toBeGreaterThan(0);
  });

  it("renders the inline error next to model and does NOT save", async () => {
    await open();
    setInputValue("settings-model", "");

    await submitForm();

    expect(api.saveSettings).not.toHaveBeenCalled();
    const span = document.querySelector(
      '.field-error[data-field="model"]'
    );
    expect(span.textContent.length).toBeGreaterThan(0);
  });

  it("renders all inline errors when multiple fields fail", async () => {
    await open();
    setInputValue("settings-api-url", "ftp://nope");
    setInputValue("settings-model", "");
    setInputValue("settings-temperature", "-1");

    await submitForm();

    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(
      document.querySelector('.field-error[data-field="api_url"]').textContent
    ).not.toBe("");
    expect(
      document.querySelector('.field-error[data-field="model"]').textContent
    ).not.toBe("");
    expect(
      document.querySelector('.field-error[data-field="temperature"]').textContent
    ).not.toBe("");
  });

  it("clears stale inline errors on the next valid submit", async () => {
    await open();
    setInputValue("settings-model", "");
    await submitForm();
    const span = document.querySelector(
      '.field-error[data-field="model"]'
    );
    expect(span.textContent.length).toBeGreaterThan(0);

    setInputValue("settings-model", "valid-model");
    await submitForm();

    expect(span.textContent).toBe("");
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });
});

describe("Save failure (Req 11.9)", () => {
  it("keeps the modal open, renders the failure in .modal-error, preserves edits", async () => {
    api.saveSettings.mockRejectedValueOnce(
      new Error("settings could not be saved: denied")
    );
    await open();
    setInputValue("settings-model", "edited-model");
    setInputValue("settings-temperature", "0.5");

    await submitForm();

    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(isModalOpen()).toBe(true);
    expect(document.querySelector("#settings-modal").hidden).toBe(false);
    expect(document.querySelector(".modal-error").textContent).toBe(
      "settings could not be saved: denied"
    );
    // Edits are preserved
    expect(inputValue("settings-model")).toBe("edited-model");
    expect(inputValue("settings-temperature")).toBe("0.5");
  });

  it("propagates a string rejection reason verbatim", async () => {
    api.saveSettings.mockRejectedValueOnce("settings invalid: temperature");
    await open();

    await submitForm();

    expect(document.querySelector(".modal-error").textContent).toBe(
      "settings invalid: temperature"
    );
    expect(isModalOpen()).toBe(true);
  });
});

/* -------------------- Cancel button (Req 11.8) ----------------------- */

describe("Cancel button", () => {
  it("closes the modal without invoking saveSettings", async () => {
    await open();
    setInputValue("settings-model", "discarded");

    document.querySelector('button[data-action="cancel"]').click();

    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(isModalOpen()).toBe(false);
    expect(document.querySelector("#settings-modal").hidden).toBe(true);
  });

  it("the next open re-populates from loadSettings, discarding edits", async () => {
    await open();
    setInputValue("settings-model", "discarded");
    document.querySelector('button[data-action="cancel"]').click();

    api.loadSettings.mockResolvedValueOnce({
      ...VALID_SETTINGS,
      model: "fresh-model",
    });
    await open();

    expect(inputValue("settings-model")).toBe("fresh-model");
  });
});
