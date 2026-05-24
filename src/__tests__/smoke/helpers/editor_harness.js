// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import * as editor from "../../../editor.js";

/**
 * @param {string} [initialValue]
 * @returns {HTMLTextAreaElement}
 */
export function setupEditorHarness(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  editor.initialize();
  return el;
}

/**
 * @param {HTMLTextAreaElement} el
 * @param {number} start
 * @param {number} end
 * @returns {void}
 */
export function selectRange(el, start, end) {
  el.focus();
  el.selectionStart = start;
  el.selectionEnd = end;
}

/**
 * @param {string} doc
 * @param {string} needle
 * @returns {{ start: number, end: number }}
 */
export function selectSubstring(doc, needle) {
  const start = doc.indexOf(needle);
  if (start < 0) {
    throw new Error(`substring not found for selection: ${needle}`);
  }
  return { start, end: start + needle.length };
}
