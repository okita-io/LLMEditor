// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Tool Console — run a named tool from the implementation pane against the
// live document buffer before invoking the agent.

import { registerEditTarget } from "./edit_target.js";
import { executeAgentTool, getAgentToolSchemas } from "./tool_editor.js";

/** @type {HTMLInputElement | null} */
let consoleInputEl = null;
/** @type {HTMLElement | null} */
let consoleOutputEl = null;

/** @type {(() => { text: string, path: string | null, refreshWindow?: Function } | null) | null} */
let getContextFn = null;

/** @type {((name: string, result: Record<string, unknown>) => void) | null} */
let applyResultFn = null;

const MAX_OUTPUT_LINES = 80;

/**
 * @param {string} toolName
 * @returns {string[]}
 */
export function getSchemaParameterOrder(toolName) {
  const schemas = getAgentToolSchemas();
  for (const entry of schemas) {
    const fn =
      entry && typeof entry === "object" && entry.function && typeof entry.function === "object"
        ? entry.function
        : null;
    const name =
      fn && typeof fn.name === "string"
        ? fn.name
        : typeof entry.name === "string"
          ? entry.name
          : "";
    if (name !== toolName) continue;

    const params =
      fn && typeof fn.parameters === "object" && fn.parameters !== null ? fn.parameters : {};
    const props =
      params && typeof params.properties === "object" && params.properties !== null
        ? params.properties
        : {};
    const required = Array.isArray(params.required) ? params.required : [];
    const ordered = [];
    for (const key of required) {
      if (typeof key === "string" && key in props && !ordered.includes(key)) {
        ordered.push(key);
      }
    }
    for (const key of Object.keys(props)) {
      if (!ordered.includes(key)) ordered.push(key);
    }
    return ordered;
  }
  return [];
}

/**
 * @param {string} inner
 * @returns {unknown[]}
 */
function parsePositionalArgList(inner) {
  if (!inner.trim()) return [];
  return new Function(`"use strict"; return [${inner}]`)();
}

/**
 * @param {string} toolName
 * @param {unknown[]} values
 * @returns {Record<string, unknown>}
 */
function positionalArgsToObject(toolName, values) {
  const names = getSchemaParameterOrder(toolName);
  /** @type {Record<string, unknown>} */
  const args = {};
  for (let i = 0; i < values.length; i += 1) {
    if (names[i]) args[names[i]] = values[i];
  }
  return args;
}

/**
 * Parse a console command line.
 *
 * Supported forms:
 *   tool_name
 *   tool_name {"line":1,"text":"hi"}
 *   tool_name({"line":1,"text":"hi"})
 *   tool_name(1, "hi")  — positional args mapped to schema parameter order
 *
 * @param {string} line
 * @returns {{ ok: true, name: string, args: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseToolConsoleCommand(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) {
    return { ok: false, error: "Enter a tool command." };
  }

  const nameMatch = trimmed.match(/^([A-Za-z_][\w]*)/);
  if (!nameMatch) {
    return { ok: false, error: "Command must start with a tool name." };
  }

  const name = nameMatch[1];
  let rest = trimmed.slice(name.length).trim();
  if (!rest) {
    return { ok: true, name, args: {} };
  }

  if (rest.startsWith("{")) {
    try {
      const args = JSON.parse(rest);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: "Arguments must be a JSON object." };
      }
      return { ok: true, name, args: /** @type {Record<string, unknown>} */ (args) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Invalid JSON arguments: ${msg}` };
    }
  }

  if (!rest.startsWith("(")) {
    return {
      ok: false,
      error: `Expected "(" or "{" after tool name. Example: ${name}({"line":1,"text":"…"})`,
    };
  }

  if (!rest.endsWith(")")) {
    return { ok: false, error: "Unclosed argument list — add a closing )." };
  }

  const inner = rest.slice(1, -1).trim();
  if (!inner) {
    return { ok: true, name, args: {} };
  }

  if (inner.startsWith("{")) {
    try {
      const args = JSON.parse(inner);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: "Arguments must be a JSON object." };
      }
      return { ok: true, name, args: /** @type {Record<string, unknown>} */ (args) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Invalid JSON arguments: ${msg}` };
    }
  }

  try {
    const values = parsePositionalArgList(inner);
    return { ok: true, name, args: positionalArgsToObject(name, values) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not parse arguments: ${msg}` };
  }
}

/**
 * @param {Record<string, unknown>} result
 * @returns {string}
 */
function formatToolResult(result) {
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * @param {"command"|"ok"|"error"} kind
 * @param {string} text
 */
function appendConsoleLine(kind, text) {
  if (!consoleOutputEl) return;
  const line = document.createElement("div");
  line.className = `tool-console-line tool-console-line-${kind}`;
  line.textContent = text;
  consoleOutputEl.appendChild(line);
  while (consoleOutputEl.childElementCount > MAX_OUTPUT_LINES) {
    consoleOutputEl.firstElementChild?.remove();
  }
  consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
}

/**
 * @param {string} commandLine
 * @returns {Promise<void>}
 */
export async function runToolConsoleCommand(commandLine) {
  const parsed = parseToolConsoleCommand(commandLine);
  appendConsoleLine("command", `> ${commandLine.trim()}`);

  if (!parsed.ok) {
    appendConsoleLine("error", parsed.error);
    return;
  }

  const ctx = typeof getContextFn === "function" ? getContextFn() : null;
  if (!ctx) {
    appendConsoleLine("error", "Document buffer is not available.");
    return;
  }

  const result = await executeAgentTool(parsed.name, parsed.args, ctx);
  if (result.ok === false) {
    const err =
      typeof result.error === "string" && result.error.length > 0
        ? result.error
        : "Tool returned ok:false.";
    appendConsoleLine("error", err);
    return;
  }

  if (typeof applyResultFn === "function") {
    applyResultFn(parsed.name, result);
  }

  const summary =
    result.changed === true
      ? "ok (document updated)"
      : result.changed === false
        ? "ok (no document change)"
        : "ok";
  appendConsoleLine("ok", summary);
  appendConsoleLine("ok", formatToolResult(result));
}

/**
 * Wire buffer context and side-effect application (from editor.js via main.js).
 *
 * @param {{
 *   getContext?: () => { text: string, path: string | null, refreshWindow?: Function } | null,
 *   applyResult?: (name: string, result: Record<string, unknown>) => void,
 * }} hooks
 */
export function setToolConsoleRuntime(hooks = {}) {
  getContextFn = typeof hooks.getContext === "function" ? hooks.getContext : null;
  applyResultFn = typeof hooks.applyResult === "function" ? hooks.applyResult : null;
}

/**
 * @returns {void}
 */
export function initToolConsole() {
  consoleInputEl = /** @type {HTMLInputElement | null} */ (
    document.getElementById("tool-console-input")
  );
  consoleOutputEl = document.getElementById("tool-console-output");
  const consoleRoot = document.getElementById("tool-console");
  const inputRow = consoleRoot?.querySelector(".tool-console-input-row");
  if (!consoleInputEl) return;

  const focusInput = () => {
    consoleInputEl?.focus();
  };

  inputRow?.addEventListener("mousedown", (event) => {
    if (event.target === consoleInputEl) return;
    event.preventDefault();
    focusInput();
  });
  consoleRoot?.addEventListener("mousedown", (event) => {
    if (event.target === consoleInputEl || inputRow?.contains(/** @type {Node} */ (event.target))) {
      return;
    }
    focusInput();
  });

  registerEditTarget("tool-console", {
    undo: () => {},
    redo: () => {},
    elements: [consoleInputEl],
    panes: [consoleRoot, inputRow],
  });

  consoleInputEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    const line = consoleInputEl.value;
    if (!line.trim()) return;
    consoleInputEl.value = "";
    void runToolConsoleCommand(line);
  });
}

export const _internal = {
  appendConsoleLine,
  clearConsoleOutput() {
    if (consoleOutputEl) consoleOutputEl.replaceChildren();
  },
  getConsoleInputEl: () => consoleInputEl,
  getConsoleOutputEl: () => consoleOutputEl,
  resetForTests() {
    consoleInputEl = null;
    consoleOutputEl = null;
    getContextFn = null;
    applyResultFn = null;
  },
};
