// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Routes Edit → Undo/Redo to the edit surface the user last clicked
// (document buffer, tool implementation pane, or tool schema pane).

/** @type {string} */
let lastEditTargetId = "document";

/** @type {Map<string, { undo: () => void, redo: () => void }>} */
const targets = new Map();

/** @type {WeakSet<EventTarget>} */
const wiredNodes = new WeakSet();

/**
 * @param {EventTarget | null | undefined} node
 * @param {() => void} mark
 */
function wireTargetNode(node, mark) {
  if (!node || typeof node.addEventListener !== "function") return;
  if (wiredNodes.has(node)) return;
  wiredNodes.add(node);
  node.addEventListener("mousedown", mark);
  node.addEventListener("focusin", mark);
}

/**
 * @param {string} id
 * @returns {void}
 */
export function setLastEditTarget(id) {
  if (typeof id === "string" && id.length > 0) {
    lastEditTargetId = id;
  }
}

/**
 * @returns {string}
 */
export function getLastEditTarget() {
  return lastEditTargetId;
}

/**
 * Register an edit surface and wire pointer/focus handlers so clicking
 * or focusing it becomes the active undo/redo target.
 *
 * @param {string} id
 * @param {{
 *   undo: () => void,
 *   redo: () => void,
 *   elements?: Array<HTMLElement | null | undefined>,
 *   panes?: Array<HTMLElement | null | undefined>,
 * }} spec
 * @returns {void}
 */
export function registerEditTarget(id, spec) {
  targets.set(id, { undo: spec.undo, redo: spec.redo });

  const mark = () => setLastEditTarget(id);
  for (const node of [...(spec.elements ?? []), ...(spec.panes ?? [])]) {
    wireTargetNode(node, mark);
  }
}

/**
 * @returns {void}
 */
export function undoActiveEditTarget() {
  targets.get(lastEditTargetId)?.undo?.();
}

/**
 * @returns {void}
 */
export function redoActiveEditTarget() {
  targets.get(lastEditTargetId)?.redo?.();
}

/**
 * Test hook: reset routing state.
 * @returns {void}
 */
export function resetEditTargetsForTests() {
  lastEditTargetId = "document";
  targets.clear();
}
