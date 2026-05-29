// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Bundled default.lmtools — editor tool schemas + implementation.

/** @type {Set<string>} */
export const DEFAULT_TOOL_NAMES = new Set([
  "get_document",
  "goto_line",
  "insert_text",
  "replace_line",
  "replace_span",
  "delete_lines",
  "delete_span",
]);

/** @type {{ implementation: string, schemas: Array<Record<string, unknown>> } | null} */
let cache = null;

/** @type {string | null} */
let testOverrideRaw = null;

/**
 * @param {string} raw
 * @returns {{ implementation: string, schemas: Array<Record<string, unknown>> }}
 */
function parseDefaultBundle(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) throw new Error("default.lmtools: empty file");

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`default.lmtools: invalid JSON (${msg})`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("default.lmtools: expected a JSON object");
  }

  const implementation =
    typeof parsed.implementation === "string" ? parsed.implementation : "";
  let schema = "";
  if (parsed.schema !== undefined && parsed.schema !== null) {
    schema =
      typeof parsed.schema === "string"
        ? parsed.schema
        : JSON.stringify(parsed.schema, null, 2);
  }
  if (!schema.trim()) throw new Error("default.lmtools: missing schema");

  const schemaParsed = JSON.parse(schema);
  const schemas = Array.isArray(schemaParsed) ? schemaParsed : [schemaParsed];
  return { implementation, schemas };
}

/**
 * Load default.lmtools from the app bundle (or test override).
 * @returns {Promise<{ implementation: string, schemas: Array<Record<string, unknown>> }>}
 */
export async function ensureDefaultToolsLoaded() {
  if (cache) return cache;

  const raw =
    typeof testOverrideRaw === "string"
      ? testOverrideRaw
      : await fetch("./default.lmtools").then((r) => {
          if (!r.ok) throw new Error(`Failed to load default.lmtools (${r.status})`);
          return r.text();
        });

  cache = parseDefaultBundle(raw);
  return cache;
}

/** @returns {Array<Record<string, unknown>>} */
export function getDefaultToolSchemas() {
  return cache ? [...cache.schemas] : [];
}

/** @returns {string} */
export function getDefaultToolImplementation() {
  return cache?.implementation ?? "";
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isDefaultTool(name) {
  return DEFAULT_TOOL_NAMES.has(name);
}

/**
 * Execute a built-in tool via the default.lmtools implementation.
 *
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function executeDefaultTool(name, args, ctx) {
  const code = getDefaultToolImplementation().trim();
  if (!code) {
    return {
      ok: false,
      error: `Default tool "${name}" is not loaded.`,
      changed: false,
    };
  }

  try {
    const AsyncFunction = /** @type {typeof Function} */ (
      Object.getPrototypeOf(async function () {}).constructor
    );
    const fn = new AsyncFunction(
      "args",
      "ctx",
      `${code}\nreturn await run(args, ctx);`
    );
    const result = await fn(args, { ...ctx, toolName: name });
    if (result == null || typeof result !== "object") {
      return { ok: true, result: result ?? "(no return value)", changed: false };
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Default tool execution error: ${msg}`, changed: false };
  }
}

export const _internal = {
  resetForTests() {
    cache = null;
    testOverrideRaw = null;
  },
  setTestOverrideRaw(raw) {
    testOverrideRaw = raw;
    cache = null;
  },
  setCacheForTests(bundle) {
    cache = bundle;
  },
};
