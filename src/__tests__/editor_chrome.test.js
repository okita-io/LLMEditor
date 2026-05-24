// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from "vitest";
import {
  attachEditorChrome,
  cursorPosition,
  selectionOverlayRects,
  _internal,
} from "../editor_chrome.js";

function installEditorDom() {
  document.body.innerHTML = `
    <aside id="chat-panel">
      <textarea id="chat-input"></textarea>
    </aside>
    <div id="editor-body" class="editor-body">
      <div id="line-gutter"></div>
      <div class="editor-buffer-wrap">
        <div id="selection-overlay"></div>
        <textarea id="buffer"></textarea>
        <div id="buffer-mirror"></div>
      </div>
    </div>
  `;
  return /** @type {HTMLTextAreaElement} */ (document.getElementById("buffer"));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("editor_chrome ghost selection", () => {
  it("shows overlay and gutter range when chat input is focused", () => {
    const buffer = installEditorDom();
    buffer.value = "alpha\nbeta\ngamma";
    buffer.selectionStart = 6;
    buffer.selectionEnd = 10;
    attachEditorChrome(buffer);

    const chatInput = document.getElementById("chat-input");
    chatInput.focus();

    expect(document.getElementById("editor-body").classList.contains("show-ghost-selection")).toBe(
      true
    );
    expect(document.querySelectorAll(".ghost-selection-rect").length).toBeGreaterThan(0);
    expect(document.querySelector(".line-selected")).not.toBeNull();
  });

  it("hides ghost overlay when buffer regains focus", () => {
    const buffer = installEditorDom();
    buffer.value = "hello";
    buffer.selectionStart = 1;
    buffer.selectionEnd = 3;
    attachEditorChrome(buffer);

    document.getElementById("chat-input").focus();
    buffer.focus();

    expect(document.getElementById("editor-body").classList.contains("show-ghost-selection")).toBe(
      false
    );
    expect(document.querySelectorAll(".ghost-selection-rect").length).toBe(0);
  });

  it("keeps caret overlay for collapsed selection", () => {
    const buffer = installEditorDom();
    buffer.value = "one\ntwo";
    buffer.selectionStart = 4;
    buffer.selectionEnd = 4;
    attachEditorChrome(buffer);

    document.getElementById("chat-input").focus();

    expect(document.querySelector(".ghost-caret")).not.toBeNull();
  });

  it("uses pinned selection for context when chat is focused", () => {
    const buffer = installEditorDom();
    buffer.value = "hello\nworld";
    attachEditorChrome(buffer);

    buffer.selectionStart = 6;
    buffer.selectionEnd = 11;
    buffer.focus();

    document.getElementById("chat-input").focus();

    buffer.selectionStart = 0;
    buffer.selectionEnd = 0;

    expect(_internal.getSelectionForContext(buffer)).toEqual({ start: 6, end: 11 });
  });
});

describe("selectionOverlayRects", () => {
  it("returns one caret rect for collapsed selection", () => {
    const buffer = installEditorDom();
    buffer.value = "abcd\nefgh";
    const rects = selectionOverlayRects(buffer, 5, 5);
    expect(rects).toHaveLength(1);
    expect(rects[0].kind).toBe("caret");
  });

  it("returns one rect per touched line for multi-line selection", () => {
    const buffer = installEditorDom();
    buffer.value = "aaaa\nbbbb\ncccc";
    const rects = selectionOverlayRects(buffer, 2, 8);
    expect(rects).toHaveLength(2);
    expect(rects.every((rect) => rect.kind === "selection")).toBe(true);
  });
});

describe("cursorPosition", () => {
  it("reports 1-based line and column", () => {
    expect(cursorPosition("a\nbc", 3)).toEqual({ line: 2, column: 2 });
  });
});

describe("_internal.renderLineNumbers", () => {
  it("marks all selected lines in the gutter", () => {
    const html = _internal.renderLineNumbers("a\nb\nc", 2, 1, 3, true);
    expect(html.match(/line-selected/g)?.length).toBe(3);
  });
});

describe("_internal.buildMirrorHtml", () => {
  it("uses block rows with a zero-width space for empty lines", () => {
    const html = _internal.buildMirrorHtml(["wrapped line", ""]);
    expect(html).toContain('<div data-ln="0">wrapped line</div>');
    expect(html).toContain('<div data-ln="1">\u200b</div>');
  });
});
