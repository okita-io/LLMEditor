// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// tool_editor.js — live JS implementation + JSON schema editor panes.

import * as api from "./api.js";
import { getTabSpaces } from "./editor_tab_settings.js";
import { registerEditTarget } from "./edit_target.js";
import { refreshEditorChrome } from "./editor_chrome.js";
import { notifyRefresh as notifyEditorDisplayRefresh } from "./editor_display.js";
import { showConfirmModal } from "./inference_panel.js";
import { attachCodeHighlight } from "./tool_code_highlight.js";
import { attachTextareaEditHistory } from "./textarea_edit_history.js";

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
/**
 * Most recently valid parsed tool schemas. Retained so an in-progress invalid
 * edit to the Schema_Pane does not strip the model's tools (Req 5.8). The
 * status display still reflects the current (possibly invalid) content via
 * schemaValid, but getAgentToolSchemas falls back to this when invalid.
 * @type {Array<Record<string, unknown>>}
 */
let lastValidParsedTools = [];
/** @type {boolean} */
let schemaValid = true;

/** @type {string | null} */
let testImplementationOverride = null;

/**
 * Memoized compilation of the Implementation_Pane source into a name→function
 * registry. Keyed on the exact source string so unsaved Implementation_Pane
 * edits (a new string) trigger recompilation (Req 5.4, 5.5) while repeated
 * calls with unchanged source reuse the compiled registry.
 * @type {{ source: string, registry: Record<string, Function> } | null}
 */
let compiledImplCache = null;

/** @type {(() => Promise<string|null>) | null} */
let openDialogOverride = null;
/** @type {((ext: string) => Promise<string|null>) | null} */
let saveDialogOverride = null;

const TOOL_FILE_EXT = ".lmtool";
const TOOL_FILE_VERSION = 1;

/** @type {ReturnType<typeof attachTextareaEditHistory> | null} */
let implEditHistory = null;
/** @type {ReturnType<typeof attachTextareaEditHistory> | null} */
let schemaEditHistory = null;

// ─── Schema validation ────────────────────────────────────────────────────────

/**
 * @param {string} raw
 * @returns {boolean}
 */
function applySchemaFromRaw(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";

  if (!trimmed) {
    parsedTools = [];
    lastValidParsedTools = [];
    schemaValid = true;
    updateSchemaStatus("", "idle");
    notifyToolFileChanged();
    return true;
  }

  try {
    const parsed = JSON.parse(trimmed);
    parsedTools = Array.isArray(parsed) ? parsed : [parsed];
    const seen = new Set();
    const duplicates = [];
    for (const tool of parsedTools) {
      const fn = tool.function;
      const name =
        fn && typeof fn === "object" && typeof fn.name === "string"
          ? fn.name
          : typeof tool.name === "string"
            ? tool.name
            : "";
      if (!name) continue;
      if (seen.has(name)) duplicates.push(name);
      else seen.add(name);
    }
    if (duplicates.length > 0) {
      parsedTools = [];
      schemaValid = false;
      updateSchemaStatus(
        `✗ duplicate name(s): ${[...new Set(duplicates)].join(", ")}`,
        "error"
      );
      notifyToolFileChanged();
      return false;
    }
    schemaValid = true;
    const n = parsedTools.length;
    lastValidParsedTools = parsedTools;
    updateSchemaStatus(`✓ ${n} tool${n !== 1 ? "s" : ""}`, "valid");
  } catch (err) {
    parsedTools = [];
    schemaValid = false;
    const msg = err instanceof Error ? err.message : String(err);
    updateSchemaStatus(`✗ ${msg.split("\n")[0]}`, "error");
    notifyToolFileChanged();
    return false;
  }
  notifyToolFileChanged();
  return true;
}

function revalidateSchema() {
  if (!schemaEditorEl) return;
  applySchemaFromRaw(schemaEditorEl.value);
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
  implEditHistory?.clear();
  schemaEditHistory?.clear();
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
      { name: "LLIMEdit tools", extensions: ["lmtool", "lmtools"] },
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
      { name: "LLIMEdit tools", extensions: ["lmtool", "lmtools"] },
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
  implEditHistory?.clear();
  schemaEditHistory?.clear();
  revalidateSchema();
  clearToolDirty();
  syncToolFileControls();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Tools from the user's .lmtool file only. */
export function getUserTools() {
  return parsedTools;
}

/**
 * Schema_Accessor. Tools from the loaded tool file (sent to LM Studio).
 * Returns the loaded Tool_Schema array, or [] when nothing is loaded.
 * When the current Schema_Pane buffer is invalid, returns the most recently
 * valid tool definitions so an in-progress invalid edit does not strip the
 * model's tools (Req 5.8). The status display still reflects the current
 * invalid content via schemaValid / updateSchemaStatus (Req 4.7).
 * @returns {Array<Record<string, unknown>>}
 */
export function getAgentToolSchemas() {
  return schemaValid ? parsedTools : lastValidParsedTools;
}

export function hasCustomTools() {
  return schemaValid && parsedTools.length > 0;
}

/**
 * Schema-membership check. Reads tool names from getAgentToolSchemas() so the
 * Agent_Loop's unknown-tool detection mirrors exactly the schema advertised to
 * the model (including last-valid retention when the current edit is invalid).
 * @param {string} name
 * @returns {boolean}
 */
export function isUserCustomTool(name) {
  for (const tool of getAgentToolSchemas()) {
    const fn = tool.function;
    if (fn && typeof fn === "object" && fn.name === name) return true;
    if (tool.name === name) return true;
  }
  return false;
}

/** @deprecated Use isUserCustomTool — kept for call-site compatibility. */
export function isCustomTool(name) {
  return isUserCustomTool(name);
}

/**
 * Reads the current Implementation_Pane source, mirroring how
 * executeCustomTool reads it so the two stay consistent: the live pane value
 * when the editor is mounted, otherwise the test override.
 * @returns {string}
 */
function readImplementationSource() {
  return implEditorEl ? implEditorEl.value : testImplementationOverride ?? "";
}

/**
 * Function_Accessor. Compiles the loaded Tool_Implementation and returns a
 * name→function registry of callable Document_Tool functions. The per-tool
 * functions close over any helpers defined in the implementation string.
 *
 * - Returns the `tools` registry object when the implementation defines one.
 * - Returns `{ run }` for implementations that define only `run`.
 * - Returns `{}` for empty/whitespace implementations.
 *
 * Compilation is memoized on the exact source string so unsaved
 * Implementation_Pane edits (a new string) trigger recompilation (Req 5.4,
 * 5.5) while repeated calls with unchanged source reuse the compiled registry.
 * @returns {Record<string, (args: object, ctx: object) => (object | Promise<object>)>}
 */
export function getAgentToolFunctions() {
  const code = readImplementationSource().trim();

  if (!code) {
    return {};
  }

  if (compiledImplCache && compiledImplCache.source === code) {
    return compiledImplCache.registry;
  }

  const factory = new Function(
    `${code}\n;return (typeof tools !== 'undefined' && tools) ? tools : (typeof run === 'function' ? { run } : {});`
  );
  const registry = factory();
  const resolved =
    registry && typeof registry === "object" ? registry : {};
  compiledImplCache = { source: code, registry: resolved };
  return resolved;
}

/**
 * Tool_Runtime. Resolves the executable function for `name` from
 * getAgentToolFunctions and executes it, following the design's resolution
 * algorithm.
 *
 * - Empty/whitespace implementation → no-implementation result (Req 10.1).
 * - Resolve `fn` from the compiled registry; fall back to a `run`-dispatch
 *   wrapper when the name is absent but `run` exists (user tools + legacy
 *   names). Otherwise → no-available-implementation result (Req 3.5).
 * - Run `fn(args, { ...ctx, toolName: name })` inside try/catch; non-object
 *   returns wrap as `{ ok:true, result, changed:false }`; thrown errors return
 *   a tool-execution-error result (Req 10.2 / 10.4).
 *
 * @param {string} name
 * @param {object} args
 * @param {object} ctx
 * @returns {Promise<Record<string, unknown>>} a Tool_Result
 */
export async function executeAgentTool(name, args, ctx) {
  const code = readImplementationSource().trim();

  if (!code) {
    return {
      ok: false,
      error: `Tool "${name}" has no implementation in the JS pane.`,
      changed: false,
    };
  }

  let fns;
  try {
    fns = getAgentToolFunctions();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Tool compilation error: ${msg}`, changed: false };
  }

  let fn = fns[name];
  if (typeof fn !== "function") {
    if (typeof fns.run === "function") {
      fn = (a, c) => fns.run(a, c);
    } else {
      return {
        ok: false,
        error: `Tool "${name}" has no available implementation.`,
        changed: false,
      };
    }
  }

  try {
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

/**
 * @deprecated Alias retained so existing call sites (agent.js / editor.js)
 * keep working mid-refactor. Tasks 5.1 and 7.1 repoint those call sites to
 * executeAgentTool, after which this alias can be removed.
 */
export { executeAgentTool as executeCustomTool };

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

  implEditHistory?.destroy();
  schemaEditHistory?.destroy();
  const historyOptions = { getTabSpaces };
  implEditHistory = attachTextareaEditHistory(implEditorEl, historyOptions);
  schemaEditHistory = attachTextareaEditHistory(schemaEditorEl, historyOptions);

  registerEditTarget("tool-impl", {
    undo: () => implEditHistory?.undo(),
    redo: () => implEditHistory?.redo(),
    elements: [implEditorEl],
    panes: [document.getElementById("tool-impl-pane")],
  });
  registerEditTarget("tool-schema", {
    undo: () => schemaEditHistory?.undo(),
    redo: () => schemaEditHistory?.redo(),
    elements: [schemaEditorEl],
    panes: [document.getElementById("tool-schema-pane")],
  });

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
    lastValidParsedTools = [];
    schemaValid = true;
    testImplementationOverride = null;
    compiledImplCache = null;
    openDialogOverride = null;
    saveDialogOverride = null;
    implEditHistory?.clear();
    schemaEditHistory?.clear();
    if (schemaEditorEl) schemaEditorEl.value = "";
    if (implEditorEl) implEditorEl.value = "";
    revalidateSchema();
    syncToolFileControls();
  },
  /**
   * Load tool implementation + schema without file I/O (tests only).
   * @param {{ implementation: string, schema: string | Array<Record<string, unknown>> | Record<string, unknown> }} bundle
   */
  setLoadedToolsForTests(bundle) {
    testImplementationOverride =
      typeof bundle?.implementation === "string" ? bundle.implementation : "";
    const schemaRaw =
      typeof bundle?.schema === "string"
        ? bundle.schema
        : bundle?.schema != null
          ? JSON.stringify(bundle.schema, null, 2)
          : "";
    if (schemaEditorEl) schemaEditorEl.value = schemaRaw;
    if (implEditorEl) implEditorEl.value = testImplementationOverride;
    implEditHistory?.clear();
    schemaEditHistory?.clear();
    applySchemaFromRaw(schemaRaw);
  },
};
