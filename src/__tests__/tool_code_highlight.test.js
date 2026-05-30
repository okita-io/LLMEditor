// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { describe, expect, it } from "vitest";
import { highlightJavaScript, highlightJson } from "../tool_code_highlight.js";

describe("tool_code_highlight", () => {
  /**
   * @param {string} html
   * @param {string} source
   */
  function expectValidHighlightHtml(html, source) {
    expect(html).not.toMatch(/class=<span/);
    const doc = new DOMParser().parseFromString(
      `<pre><code>${html}</code></pre>`,
      "text/html"
    );
    expect(doc.querySelector("code")?.textContent).toBe(source);
  }

  it("highlights JSON keys without leaking span markup into output", () => {
    const source = '{\n  "type": "object",\n  "required": true\n}';
    const html = highlightJson(source);
    expectValidHighlightHtml(html, source);
    expect(html).toContain('<span class="hl-key">"type"</span>');
    expect(html).toContain('<span class="hl-string">"object"</span>');
    expect(html).toContain('<span class="hl-keyword">true</span>');
  });

  it("highlights JavaScript without leaking span markup into output", () => {
    const source = 'const name = "hello";\n// comment\nreturn null;';
    const html = highlightJavaScript(source);
    expectValidHighlightHtml(html, source);
    expect(html).toContain('<span class="hl-keyword">const</span>');
    expect(html).toContain('<span class="hl-string">"hello"</span>');
    expect(html).toContain('<span class="hl-comment">// comment</span>');
  });
});
