// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Editor display preferences: font size and visible whitespace.

export const EDITOR_FONT_SIZE_MIN = 10;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZE_DEFAULT = 14;

/** @type {boolean} */
let showWhitespace = false;
/** @type {Set<() => void>} */
const refreshCallbacks = new Set();

/**
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeEditorFontSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return EDITOR_FONT_SIZE_DEFAULT;
  return Math.round(
    Math.max(EDITOR_FONT_SIZE_MIN, Math.min(EDITOR_FONT_SIZE_MAX, n))
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function normalizeShowWhitespace(value) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return false;
}

/**
 * @returns {boolean}
 */
export function isShowWhitespace() {
  return showWhitespace;
}

/**
 * @param {number} sizePx
 * @returns {void}
 */
export function applyEditorFontSize(sizePx) {
  const size = normalizeEditorFontSize(sizePx);
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${size}px`
    );
  }
  notifyRefresh();
}

/**
 * @param {boolean} enabled
 * @returns {void}
 */
export function applyShowWhitespace(enabled) {
  showWhitespace = Boolean(enabled);
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle(
      "show-editor-whitespace",
      showWhitespace
    );
  }
  notifyRefresh();
}

/**
 * @param {object | null | undefined} settings
 * @returns {void}
 */
export function applyEditorDisplaySettings(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  applyEditorFontSize(s.editor_font_size);
  applyShowWhitespace(s.show_whitespace);
}

/**
 * @param {() => void} fn
 * @returns {() => void}
 */
export function onEditorDisplayRefresh(fn) {
  refreshCallbacks.add(fn);
  return () => refreshCallbacks.delete(fn);
}

/**
 * @returns {void}
 */
export function notifyRefresh() {
  for (const fn of refreshCallbacks) {
    try {
      fn();
    } catch (err) {
      console.error("[editor_display] refresh callback failed", err);
    }
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render buffer text with visible whitespace markers.
 *
 * @param {string} text
 * @returns {string}
 */
export function renderWhitespaceHtml(text) {
  const value = typeof text === "string" ? text : "";
  let html = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === " ") {
      html += '<span class="ws-visible ws-space" aria-hidden="true">\u00b7</span>';
    } else if (ch === "\t") {
      html += '<span class="ws-visible ws-tab" aria-hidden="true">\u2192</span>';
    } else if (ch === "\n") {
      html += "\n";
    } else {
      html += escapeHtml(ch);
    }
  }
  return html;
}

/**
 * Decorate text nodes in an HTML highlight string with whitespace markers.
 *
 * @param {string} html
 * @returns {string}
 */
export function decorateWhitespaceInHighlightHtml(html) {
  if (!showWhitespace || typeof html !== "string" || html.length === 0) {
    return html;
  }
  const parts = html.split(/(<[^>]*>)/g);
  return parts
    .map((part) => {
      if (part.startsWith("<")) return part;
      let decorated = "";
      for (let i = 0; i < part.length; i += 1) {
        const ch = part[i];
        if (ch === " ") {
          decorated +=
            '<span class="ws-visible ws-space" aria-hidden="true">\u00b7</span>';
        } else if (ch === "\t") {
          decorated +=
            '<span class="ws-visible ws-tab" aria-hidden="true">\u2192</span>';
        } else {
          decorated += ch;
        }
      }
      return decorated;
    })
    .join("");
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {HTMLElement} overlayEl
 * @returns {() => void}
 */
export function attachBufferWhitespaceOverlay(textarea, overlayEl) {
  const sync = () => {
    const value = textarea.value;
    const show = showWhitespace;
    overlayEl.hidden = !show;
    textarea.classList.toggle("show-whitespace-input", show);
    if (!show) {
      overlayEl.replaceChildren();
      return;
    }
    overlayEl.innerHTML =
      value.length > 0 ? renderWhitespaceHtml(value) : "\n";
    overlayEl.scrollTop = textarea.scrollTop;
    overlayEl.scrollLeft = textarea.scrollLeft;
  };

  textarea.addEventListener("input", sync);
  textarea.addEventListener("scroll", () => {
    overlayEl.scrollTop = textarea.scrollTop;
    overlayEl.scrollLeft = textarea.scrollLeft;
  });

  const off = onEditorDisplayRefresh(sync);
  sync();

  return () => {
    textarea.removeEventListener("input", sync);
    off();
    overlayEl.replaceChildren();
    overlayEl.hidden = true;
    textarea.classList.remove("show-whitespace-input");
  };
}
