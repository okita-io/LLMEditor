// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  applyEditorDisplaySettings,
  decorateWhitespaceInHighlightHtml,
  isShowWhitespace,
  normalizeEditorFontSize,
  renderWhitespaceHtml,
} from "../editor_display.js";

describe("editor_display", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--editor-font-size");
    document.documentElement.classList.remove("show-editor-whitespace");
  });

  afterEach(() => {
    applyEditorDisplaySettings({
      editor_font_size: 14,
      show_whitespace: false,
    });
  });

  it("normalizes editor font size within bounds", () => {
    expect(normalizeEditorFontSize(9)).toBe(10);
    expect(normalizeEditorFontSize(48)).toBe(32);
    expect(normalizeEditorFontSize(16)).toBe(16);
  });

  it("applies font size and whitespace settings to the document", () => {
    applyEditorDisplaySettings({
      editor_font_size: 18,
      show_whitespace: true,
    });
    expect(
      document.documentElement.style.getPropertyValue("--editor-font-size")
    ).toBe("18px");
    expect(isShowWhitespace()).toBe(true);
    expect(document.documentElement.classList.contains("show-editor-whitespace"))
      .toBe(true);
  });

  it("renders visible whitespace markers in buffer HTML", () => {
    const html = renderWhitespaceHtml("a\t b");
    expect(html).toContain("ws-space");
    expect(html).toContain("ws-tab");
    expect(html).toContain("a");
    expect(html).toContain("b");
  });

  it("decorates whitespace inside highlight HTML text nodes", () => {
    applyEditorDisplaySettings({ show_whitespace: true });
    const html = decorateWhitespaceInHighlightHtml(
      '<span class="hl-keyword">let</span> x '
    );
    expect(html).toContain("ws-space");
  });
});
