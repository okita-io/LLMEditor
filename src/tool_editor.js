// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// tool_editor.js — live JS implementation + JSON schema editor panes.

import * as api from "./api.js";
import { DEFAULT_TOOL_NAMES, getDefaultToolSchemas } from "./default_tools.js";
import { refreshEditorChrome } from "./editor_chrome.js";
import { notifyRefresh as notifyEditorDisplayRefresh } from "./editor_display.js";
import { showConfirmModal } from "./inference_panel.js";
import { attachCodeHighlight } from "./tool_code_highlight.js";

/** @type {HTMLTextAreaElement | null} */
let schemaEditorEl = null;
/** @type {HTMLTextAreaElement | null} */
let implEditorEl = null;
/** @type {HTMLInputElement | null} */
let fileNameEl = null;
/** @type {HTMLButtonElement | null} */
let deleteBtnEl = null;
/** @type {HTMLElement | null} */
let schemaStatusEl = null;
/** @type {HTMLElement | null} */
let toolPaneDividerEl = null;
/** @type {HTMLElement | null} */
let schemaToolDividerEl = null;
/** @type {HTMLElement | null} */
let docBufferPaneEl = null;
/** @type {HTMLElement | null} */
let toolEditorPaneEl = null;

/** @type {string | null} */
let currentToolPath = null;
/** @type {boolean} */
let toolDirty = false;

/** @type {Array<Record<string, unknown>>} */
let parsedTools = [];
/** @type {boolean} */
let schemaValid = true;

/** @type {(() => Promise<string|null>) | null} */
let openDialogOverride = null;
/** @type {((ext: string) => Promise<string|null>) | null} */
let saveDialogOverride = null;

const TOOL_FILE_EXT = ".lmtool";
const TOOL_FILE_VERSION = 1;

// ─── Schema validation ────────────────────────────────────────────────────────

function revalidateSchema() {
  if (!schemaEditorEl) return;
  const raw = schemaEditorEl.value.trim();

  if (!raw) {
    parsedTools = [];
    schemaValid = true;
    updateSchemaStatus("", "idle");
    notifyToolFileChanged();
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    parsedTools = Array.isArray(parsed) ? parsed : [parsed];
    const reserved = [];
    for (const tool of parsedTools) {
      const fn = tool.function;
      const name =
        fn && typeof fn === "object" && typeof fn.name === "string"
          ? fn.name
          : typeof tool.name === "string"
            ? tool.name
            : "";
      if (name && DEFAULT_TOOL_NAMES.has(name)) reserved.push(name);
    }
    if (reserved.length > 0) {
      parsedTools = [];
      schemaValid = false;
      updateSchemaStatus(
        `✗ reserved name(s): ${reserved.join(", ")} (use default.lmtools)`,
        "error"
      );
      notifyToolFileChanged();
      return;
    }
    schemaValid = true;
    const n = parsedTools.length;
    updateSchemaStatus(`✓ ${n} tool${n !== 1 ? "s" : ""}`, "valid");
  } catch (err) {
    parsedTools = [];
    schemaValid = false;
    const msg = err instanceof Error ? err.message : String(err);
    updateSchemaStatus(`✗ ${msg.split("\n")[0]}`, "error");
  }
  notifyToolFileChanged();
}

/**
 * @param {string} msg
 * @param {"idle"|"valid"|"error"} state
 */
function updateSchemaStatus(msg, state) {
  if (!schemaStatusEl) return;
  schemaStatusEl.textContent = msg;
  schemaStatusEl.setAttribute("data-state", state);
}

function markToolDirty() {
  toolDirty = true;
  syncToolFileControls();
  notifyToolFileChanged();
}

function clearToolDirty() {
  toolDirty = false;
  syncToolFileControls();
  notifyToolFileChanged();
}

function notifyToolFileChanged() {
  if (typeof document === "undefined") return;
  document.dispatchEvent(
    new CustomEvent("tool-file-changed", {
      detail: getToolFileStatus(),
    })
  );
}

function basename(path) {
  if (typeof path !== "string" || path.length === 0) return "";
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function ensureToolExtension(path) {
  if (typeof path !== "string" || path.length === 0) return path;
  const lower = path.toLowerCase();
  return lower.endsWith(TOOL_FILE_EXT) ? path : `${path}${TOOL_FILE_EXT}`;
}

function syncToolFileControls() {
  if (fileNameEl) {
    const display =
      typeof currentToolPath === "string" && currentToolPath.length > 0
        ? basename(currentToolPath)
        : fileNameEl.value.trim() || "";
    if (document.activeElement !== fileNameEl) {
      fileNameEl.value = display;
    }
  }
  if (deleteBtnEl) {
    deleteBtnEl.disabled = !(typeof currentToolPath === "string" && currentToolPath.length > 0);
  }
}

/**
 * @returns {{ path: string|null, dirty: boolean, pairCount: number, toolCount: number, schemaValid: boolean }}
 */
export function getToolFileStatus() {
  return {
    path: currentToolPath,
    dirty: toolDirty,
    pairCount: hasCustomTools() ? 1 : 0,
    toolCount: parsedTools.length,
    schemaValid,
  };
}

// ─── Tool file format ─────────────────────────────────────────────────────────

/**
 * @param {string} raw
 * @returns {{ implementation: string, schema: string }}
 */
export function parseToolFileContents(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { implementation: "", schema: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { implementation: "", schema: trimmed };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { implementation: "", schema: trimmed };
  }

  if (
    parsed.version === TOOL_FILE_VERSION ||
    Object.prototype.hasOwnProperty.call(parsed, "implementation") ||
    Object.prototype.hasOwnProperty.call(parsed, "schema")
  ) {
    const implementation =
      typeof parsed.implementation === "string" ? parsed.implementation : "";
    let schema = "";
    if (parsed.schema !== undefined && parsed.schema !== null) {
      schema =
        typeof parsed.schema === "string"
          ? parsed.schema
          : JSON.stringify(parsed.schema, null, 2);
    }
    return { implementation, schema };
  }

  return { implementation: "", schema: trimmed };
}

/**
 * @returns {string}
 */
export function serializeToolFile() {
  const implementation = implEditorEl ? implEditorEl.value : "";
  const schemaRaw = schemaEditorEl ? schemaEditorEl.value.trim() : "";

  let schema = null;
  if (schemaRaw.length > 0) {
    try {
      schema = JSON.parse(schemaRaw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Schema must be valid JSON before saving: ${msg}`);
    }
  }

  return `${JSON.stringify(
    {
      version: TOOL_FILE_VERSION,
      implementation,
      schema,
    },
    null,
    2
  )}\n`;
}

function applyToolFileContents(contents) {
  const { implementation, schema } = parseToolFileContents(contents);
  if (implEditorEl) implEditorEl.value = implementation;
  if (schemaEditorEl) schemaEditorEl.value = schema;
  revalidateSchema();
  clearToolDirty();
}

async function pathExists(path) {
  try {
    await api.openFile(path);
    return true;
  } catch {
    return false;
  }
}

async function invokeOpenDialog() {
  if (typeof openDialogOverride === "function") {
    return await openDialogOverride();
  }
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.dialog || typeof tauri.dialog.open !== "function") {
    return null;
  }
  const result = await tauri.dialog.open({
    multiple: false,
    filters: [
      { name: "LLIMEdit tools", extensions: ["lmtool"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return result.length > 0 ? result[0] : null;
  return typeof result === "string" ? result : null;
}

async function invokeSaveDialog() {
  if (typeof saveDialogOverride === "function") {
    return await saveDialogOverride(TOOL_FILE_EXT);
  }
  const tauri = globalThis.__TAURI__;
  if (!tauri || !tauri.dialog || typeof tauri.dialog.save !== "function") {
    return null;
  }
  const result = await tauri.dialog.save({
    filters: [
      { name: "LLIMEdit tools", extensions: ["lmtool"] },
      { name: "All files", extensions: ["*"] },
    ],
    defaultPath:
      typeof currentToolPath === "string" && currentToolPath.length > 0
        ? currentToolPath
        : undefined,
  });
  if (result === null || result === undefined) return null;
  return typeof result === "string" ? result : null;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function loadToolFile(path) {
  const contents = await api.openFile(path);
  applyToolFileContents(contents);
  currentToolPath = path;
  syncToolFileControls();
  notifyToolFileChanged();
  return true;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function saveToolFileToPath(path) {
  const normalized = ensureToolExtension(path);
  const contents = serializeToolFile();
  await api.saveFile(normalized, contents);
  currentToolPath = normalized;
  clearToolDirty();
  syncToolFileControls();
  return true;
}

async function onToolLoad() {
  const picked = await invokeOpenDialog();
  if (!picked) return;
  await loadToolFile(picked);
}

async function onToolSave() {
  if (typeof currentToolPath === "string" && currentToolPath.length > 0) {
    await saveToolFileToPath(currentToolPath);
    return;
  }
  await onToolSaveAs();
}

async function onToolSaveAs() {
  let picked = await invokeSaveDialog();
  if (!picked) return;
  picked = ensureToolExtension(picked);

  if (await pathExists(picked)) {
    const confirmed = await showConfirmModal(
      "Warning",
      `There is already a tool file named "${basename(picked)}" do you want to overwrite it?`,
      "Save"
    );
    if (!confirmed) return;
  }

  await saveToolFileToPath(picked);
}

async function onToolDelete() {
  if (!(typeof currentToolPath === "string" && currentToolPath.length > 0)) return;

  const name = basename(currentToolPath);
  const confirmed = await showConfirmModal(
    "Warning",
    `Are you sure you want to delete the tool file named "${name}"?`,
    "Delete"
  );
  if (!confirmed) return;

  await api.deleteFile(currentToolPath);
  currentToolPath = null;
  if (implEditorEl) implEditorEl.value = "";
  if (schemaEditorEl) schemaEditorEl.value = "";
  revalidateSchema();
  clearToolDirty();
  syncToolFileControls();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Tools from the user's .lmtool file only. */
export function getUserTools() {
  return parsedTools;
}

/** Default built-in tools + user tools (sent to LM Studio). */
export function getAgentTools() {
  return [...getDefaultToolSchemas(), ...parsedTools];
}

/** @deprecated Use getAgentTools — kept for call-site compatibility. */
export function getCustomTools() {
  return getAgentTools();
}

export function hasCustomTools() {
  return schemaValid && parsedTools.length > 0;
}

export function isUserCustomTool(name) {
  for (const tool of parsedTools) {
    const fn = tool.function;
    if (fn && typeof fn === "object" && fn.name === name) return true;
    if (tool.name === name) return true;
  }
  return false;
}

/** @deprecated Use isUserCustomTool or isDefaultTool. */
export function isCustomTool(name) {
  return isUserCustomTool(name);
}

export async function executeCustomTool(name, args, ctx) {
  const code = implEditorEl ? implEditorEl.value.trim() : "";

  if (!code) {
    return {
      ok: false,
      error: `Custom tool "${name}" has no implementation in the JS pane.`,
      changed: false,
    };
  }

  try {
    const AsyncFunction = /** @type {typeof Function} */ (
      Object.getPrototypeOf(async function () {}).constructor
    );
    const fn = new AsyncFunction("args", "ctx", `${code}\nreturn await run(args, ctx);`);
    const result = await fn(args, { ...ctx, toolName: name });
    if (result == null || typeof result !== "object") {
      return { ok: true, result: result ?? "(no return value)", changed: false };
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Tool execution error: ${msg}`, changed: false };
  }
}

// ─── Resize handles ───────────────────────────────────────────────────────────

function notifyPaneLayoutChanged() {
  refreshEditorChrome();
  notifyEditorDisplayRefresh();
  window.dispatchEvent(new Event("resize"));
}

function initHorizontalResize() {
  if (!toolPaneDividerEl || !docBufferPaneEl) return;

  let dragging = false;
  let startY = 0;
  let startDocH = 0;
  let startToolH = 0;

  toolPaneDividerEl.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startDocH = docBufferPaneEl.offsetHeight;
    startToolH = toolEditorPaneEl ? toolEditorPaneEl.offsetHeight : 200;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientY - startY;
    const container = docBufferPaneEl.parentElement;
    const containerH = container ? container.offsetHeight : startDocH + startToolH + 4;
    const dividerH = toolPaneDividerEl ? toolPaneDividerEl.offsetHeight : 4;
    const minDoc = 80;
    const minTool = 120;
    let newDocH = startDocH + delta;
    newDocH = Math.max(minDoc, newDocH);
    newDocH = Math.min(newDocH, containerH - minTool - dividerH);
    const newToolH = Math.max(minTool, containerH - newDocH - dividerH);

    docBufferPaneEl.style.flex = "none";
    docBufferPaneEl.style.height = `${newDocH}px`;
    docBufferPaneEl.style.minHeight = "0";

    if (toolEditorPaneEl) {
      toolEditorPaneEl.style.flex = "none";
      toolEditorPaneEl.style.height = `${newToolH}px`;
      toolEditorPaneEl.style.minHeight = `${minTool}px`;
    }
    notifyPaneLayoutChanged();
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    notifyPaneLayoutChanged();
  });
}

function initVerticalResize() {
  if (!schemaToolDividerEl) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;
  /** @type {HTMLElement | null} */
  let implPaneEl = null;
  /** @type {HTMLElement | null} */
  let schemaPaneEl = null;

  schemaToolDividerEl.addEventListener("mousedown", (e) => {
    implPaneEl = document.getElementById("tool-impl-pane");
    schemaPaneEl = document.getElementById("tool-schema-pane");
    if (!implPaneEl) return;
    dragging = true;
    startX = e.clientX;
    startW = implPaneEl.offsetWidth;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging || !implPaneEl) return;
    const delta = e.clientX - startX;
    const container = implPaneEl.parentElement;
    const containerW = container ? container.offsetWidth : startW * 2;
    const minPane = 150;
    let newW = Math.max(minPane, startW + delta);
    newW = Math.min(newW, containerW - minPane);
    implPaneEl.style.flex = `0 0 ${newW}px`;
    if (schemaPaneEl) {
      schemaPaneEl.style.flex = "1 1 auto";
      schemaPaneEl.style.minWidth = `${minPane}px`;
    }
    notifyPaneLayoutChanged();
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    implPaneEl = null;
    schemaPaneEl = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    notifyPaneLayoutChanged();
  });
}

function wireToolFileBar() {
  document.getElementById("tool-load")?.addEventListener("click", () => {
    onToolLoad().catch((err) => console.error("[tool_editor] load failed", err));
  });
  document.getElementById("tool-save")?.addEventListener("click", () => {
    onToolSave().catch((err) => console.error("[tool_editor] save failed", err));
  });
  document.getElementById("tool-save-as")?.addEventListener("click", () => {
    onToolSaveAs().catch((err) => console.error("[tool_editor] save as failed", err));
  });
  deleteBtnEl?.addEventListener("click", () => {
    onToolDelete().catch((err) => console.error("[tool_editor] delete failed", err));
  });

  fileNameEl?.addEventListener("input", () => {
    if (!fileNameEl) return;
    const typed = fileNameEl.value.trim();
    if (typed.length === 0) {
      currentToolPath = null;
    } else if (typeof currentToolPath === "string" && currentToolPath.length > 0) {
      const sep = currentToolPath.includes("\\") ? "\\" : "/";
      const prefix = currentToolPath.slice(0, currentToolPath.lastIndexOf(sep) + 1);
      currentToolPath = prefix ? `${prefix}${typed}` : typed;
    }
    syncToolFileControls();
    notifyToolFileChanged();
  });
}

export function initToolEditor() {
  schemaEditorEl = /** @type {HTMLTextAreaElement | null} */ (
    document.getElementById("tool-schema-editor")
  );
  implEditorEl = /** @type {HTMLTextAreaElement | null} */ (
    document.getElementById("tool-impl-editor")
  );
  fileNameEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById("tool-file-name")
  );
  deleteBtnEl = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("tool-delete")
  );
  schemaStatusEl = document.getElementById("tool-schema-status");
  toolPaneDividerEl = document.getElementById("tool-pane-divider");
  schemaToolDividerEl = document.getElementById("tool-schema-divider");
  docBufferPaneEl = document.getElementById("doc-buffer-pane");
  toolEditorPaneEl = document.getElementById("tool-editor-pane");

  if (!schemaEditorEl || !implEditorEl) {
    console.warn("[tool_editor] pane elements not found — skipping init");
    return;
  }

  schemaEditorEl.addEventListener("input", () => {
    revalidateSchema();
    markToolDirty();
  });
  implEditorEl.addEventListener("input", markToolDirty);
  revalidateSchema();
  wireToolFileBar();
  syncToolFileControls();

  attachCodeHighlight(implEditorEl, "javascript");
  attachCodeHighlight(schemaEditorEl, "json");

  initHorizontalResize();
  initVerticalResize();

  if (typeof ResizeObserver !== "undefined" && toolEditorPaneEl) {
    const ro = new ResizeObserver(() => notifyPaneLayoutChanged());
    ro.observe(toolEditorPaneEl);
    if (docBufferPaneEl) ro.observe(docBufferPaneEl);
  }
}

export const _internal = {
  parseToolFileContents,
  serializeToolFile,
  loadToolFile,
  saveToolFileToPath,
  onToolLoad,
  onToolSave,
  onToolSaveAs,
  onToolDelete,
  revalidateSchema,
  getCurrentToolPath: () => currentToolPath,
  isToolDirty: () => toolDirty,
  setDialogOverrides(overrides = {}) {
    if (!overrides || typeof overrides !== "object") {
      openDialogOverride = null;
      saveDialogOverride = null;
      return;
    }
    openDialogOverride = overrides.open || null;
    saveDialogOverride = overrides.save || null;
  },
  resetForTests() {
    currentToolPath = null;
    toolDirty = false;
    parsedTools = [];
    schemaValid = true;
    openDialogOverride = null;
    saveDialogOverride = null;
    if (schemaEditorEl) schemaEditorEl.value = "";
    if (implEditorEl) implEditorEl.value = "";
    revalidateSchema();
    syncToolFileControls();
  },
};
