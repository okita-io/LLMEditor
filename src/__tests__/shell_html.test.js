// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadShellDocument() {
  const html = readFileSync(join(srcDir, "index.html"), "utf8");
  const css = readFileSync(join(srcDir, "styles.css"), "utf8");
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/i, "")
    .replace(/<\/html>[\s\S]*$/i, "");
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

beforeEach(() => {
  document.documentElement.innerHTML = "";
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("index.html shell", () => {
  it("links styles.css and exposes the main layout regions", () => {
    const html = readFileSync(join(srcDir, "index.html"), "utf8");
    expect(html).toMatch(/href="styles\.css/);
    expect(html).toContain('id="menu-bar"');
    expect(html).toContain('id="buffer"');
    expect(html).toContain('id="status-bar"');
    expect(html).toContain('id="chat-panel"');
    expect(html).toContain('id="document-editor"');
    expect(html).toContain('id="tool-console"');
    expect(html).toContain('id="tool-console-input"');
    expect(html).toContain("llimedit-shell-rev: tool-console-1");
  });

  it("keeps #tool-console inside #tool-editor-pane", () => {
    loadShellDocument();
    const pane = document.getElementById("tool-editor-pane");
    const consoleEl = document.getElementById("tool-console");
    expect(pane).not.toBeNull();
    expect(consoleEl).not.toBeNull();
    expect(pane.contains(consoleEl)).toBe(true);
  });

  it("renders with dark theme background when styles.css is applied", () => {
    loadShellDocument();
    const bodyStyle = getComputedStyle(document.body);
    expect(bodyStyle.backgroundColor).toMatch(/rgb\(30,\s*30,\s*30\)|#1e1e1e/i);
    expect(document.getElementById("menu-bar")).not.toBeNull();
    expect(document.getElementById("buffer")).not.toBeNull();
    expect(document.querySelector(".app-header")).not.toBeNull();
  });
});
