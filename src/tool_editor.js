// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// tool_editor.js — live JS implementation + JSON schema editor panes.
//
// Exports:
//   initToolEditor()                         — bind DOM and wire interactions
//   getCustomTools()                         — parsed tool definitions array
//   hasCustomTools()                         — true when ≥1 valid tool loaded
//   isCustomTool(name)                       — true when name matches custom tool
//   executeCustomTool(name, args, ctx)       — run the JS impl pane code

/** @type {HTMLTextAreaElement | null} */
let schemaEditorEl = null;
/** @type {HTMLTextAreaElement | null} */
let implEditorEl = null;
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

/** @type {Array<Record<string, unknown>>} */
let parsedTools = [];
/** @type {boolean} */
let schemaValid = true;

// ─── Schema validation ────────────────────────────────────────────────────────

function revalidateSchema() {
  if (!schemaEditorEl) return;
  const raw = schemaEditorEl.value.trim();

  if (!raw) {
    parsedTools = [];
    schemaValid = true;
    updateSchemaStatus("", "idle");
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    parsedTools = Array.isArray(parsed) ? parsed : [parsed];
    schemaValid = true;
    const n = parsedTools.length;
    updateSchemaStatus(`✓ ${n} tool${n !== 1 ? "s" : ""}`, "valid");
  } catch (err) {
    parsedTools = [];
    schemaValid = false;
    const msg = err instanceof Error ? err.message : String(err);
    // Trim the message to the first line so it fits in the header strip.
    updateSchemaStatus(`✗ ${msg.split("\n")[0]}`, "error");
  }
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the parsed custom tool definitions (OpenAI format).
 * Empty array when the schema pane is blank or contains invalid JSON.
 *
 * @returns {Array<Record<string, unknown>>}
 */
export function getCustomTools() {
  return parsedTools;
}

/**
 * True when at least one valid custom tool is loaded.
 *
 * @returns {boolean}
 */
export function hasCustomTools() {
  return schemaValid && parsedTools.length > 0;
}

/**
 * True when `name` matches a custom tool in the schema pane.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isCustomTool(name) {
  for (const tool of parsedTools) {
    const fn = tool.function;
    if (fn && typeof fn === "object" && fn.name === name) return true;
    if (tool.name === name) return true;
  }
  return false;
}

/**
 * Execute the custom tool implementation from the JS pane.
 *
 * The JS pane must define an async `run(args, ctx)` function:
 *   - `args`: the parsed arguments the LLM passed
 *   - `ctx`:  { text: string, path: string|null } — current document
 *
 * @param {string} name  Tool name (used in error messages only)
 * @param {Record<string, unknown>} args
 * @param {{ text: string, path: string|null }} ctx
 * @returns {Promise<{ ok: boolean, result?: unknown, error?: string, changed?: boolean }>}
 */
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
    // Wrap the user code in an AsyncFunction so top-level await is allowed.
    const AsyncFunction = /** @type {typeof Function} */ (
      Object.getPrototypeOf(async function () {}).constructor
    );
    // Expects the pane to define: async function run(args, ctx) { ... }
    const fn = new AsyncFunction("args", "ctx", `${code}\nreturn await run(args, ctx);`);
    const result = await fn(args, ctx);
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
    const minTool = 80;
    const newDocH = Math.max(minDoc, Math.min(containerH - minTool - dividerH, startDocH + delta));
    const newToolH = Math.max(minTool, containerH - newDocH - dividerH);

    docBufferPaneEl.style.flex = "none";
    docBufferPaneEl.style.height = `${newDocH}px`;

    if (toolEditorPaneEl) {
      toolEditorPaneEl.style.flex = "none";
      toolEditorPaneEl.style.height = `${newToolH}px`;
    }
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });
}

function initVerticalResize() {
  if (!schemaToolDividerEl) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;
  /** @type {HTMLElement | null} */
  let implPaneEl = null;

  schemaToolDividerEl.addEventListener("mousedown", (e) => {
    implPaneEl = document.getElementById("tool-impl-pane");
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
    const maxW = container ? container.offsetWidth - 150 : Infinity;
    const newW = Math.max(150, Math.min(maxW, startW + delta));
    implPaneEl.style.flex = "none";
    implPaneEl.style.width = `${newW}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    implPaneEl = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Initialize the tool editor panes. Call once from main.js bootstrap.
 */
export function initToolEditor() {
  schemaEditorEl = /** @type {HTMLTextAreaElement | null} */ (
    document.getElementById("tool-schema-editor")
  );
  implEditorEl = /** @type {HTMLTextAreaElement | null} */ (
    document.getElementById("tool-impl-editor")
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

  schemaEditorEl.addEventListener("input", revalidateSchema);
  revalidateSchema();

  initHorizontalResize();
  initVerticalResize();
}
