// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Lightweight syntax highlighting overlay for tool editor textareas.

import {
  decorateWhitespaceInHighlightHtml,
  onEditorDisplayRefresh,
} from "./editor_display.js";

const JS_KEYWORDS =
  /\b(async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|function|if|import|in|instanceof|let|new|null|of|return|super|switch|this|throw|true|try|typeof|undefined|var|void|while|yield)\b/g;

const JS_LINE_COMMENT = /(\/\/[^\n]*)/g;
const JS_BLOCK_COMMENT = /(\/\*[\s\S]*?\*\/)/g;
const JS_STRING = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
const JS_NUMBER = /\b(0x[\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g;

const JSON_STRING = /("(?:[^"\\]|\\.)*")/g;
const JSON_NUMBER = /\b(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g;
const JSON_BOOL_NULL = /\b(true|false|null)\b/g;

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
 * Apply a highlight regex only to text nodes, not inside existing HTML tags.
 * Without this guard, later passes match attribute values such as `"hl-key"`
 * inside `<span class="hl-key">`, which corrupts the markup and leaks visible
 * fragments like `hl-key">` into the editor overlay.
 *
 * @param {string} html
 * @param {RegExp} pattern
 * @param {string} className
 * @param {Set<number>} [skip]
 * @returns {string}
 */
function highlightPattern(html, pattern, className, skip = new Set()) {
  const parts = html.split(/(<[^>]*>)/g);
  return parts
    .map((part) => {
      if (part.startsWith("<")) return part;
      return part.replace(pattern, (match, ...groups) => {
        const offset = groups[groups.length - 2];
        if (typeof offset === "number" && skip.has(offset)) return match;
        if (typeof offset === "number") skip.add(offset);
        return `<span class="hl-${className}">${match}</span>`;
      });
    })
    .join("");
}

/**
 * @param {string} source
 * @returns {string}
 */
export function highlightJavaScript(source) {
  const skip = new Set();
  let html = escapeHtml(source);
  html = highlightPattern(html, JS_BLOCK_COMMENT, "comment", skip);
  html = highlightPattern(html, JS_LINE_COMMENT, "comment", skip);
  html = highlightPattern(html, JS_STRING, "string", skip);
  html = highlightPattern(html, JS_KEYWORDS, "keyword", skip);
  html = highlightPattern(html, JS_NUMBER, "number", skip);
  return html;
}

/**
 * @param {string} source
 * @returns {string}
 */
export function highlightJson(source) {
  let html = escapeHtml(source);
  html = highlightPattern(html, JSON_BOOL_NULL, "keyword");
  html = highlightPattern(html, JSON_NUMBER, "number");
  html = highlightPattern(html, JSON_STRING, "string");
  html = html.replace(
    /<span class="hl-string">("(?:[^"\\]|\\.)*")<\/span>(\s*:)/g,
    (_m, key, colon) => `<span class="hl-key">${key}</span>${colon}`
  );
  return html;
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {"javascript"|"json"} language
 */
export function attachCodeHighlight(textarea, language) {
  const wrap = document.createElement("div");
  wrap.className = "tool-code-wrap";
  textarea.parentNode?.insertBefore(wrap, textarea);
  wrap.appendChild(textarea);

  const pre = document.createElement("pre");
  pre.className = "tool-code-highlight";
  pre.setAttribute("aria-hidden", "true");
  const code = document.createElement("code");
  code.className = `language-${language}`;
  pre.appendChild(code);
  wrap.insertBefore(pre, textarea);

  const highlight =
    language === "json" ? highlightJson : highlightJavaScript;

  const sync = () => {
    const value = textarea.value;
    let html = value.length > 0 ? highlight(value) : "\n";
    html = decorateWhitespaceInHighlightHtml(html);
    code.innerHTML = html;
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
  };

  textarea.addEventListener("input", sync);
  textarea.addEventListener("scroll", () => {
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
  });

  const offDisplay = onEditorDisplayRefresh(sync);
  sync();
  return {
    refresh: sync,
    detach: () => offDisplay(),
  };
}
