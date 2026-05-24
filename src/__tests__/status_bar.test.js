// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — status_bar.js unit tests.
//
// Covers the Task 19 surface and the formatting rules in
// Requirements 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, and 14.6:
//   - Untitled buffer vs file-path buffer (Req 9.1, 9.2).
//   - Dirty asterisk position with no intervening characters
//     (Req 9.6).
//   - "(no model)" fallback for empty/missing model (Req 9.4).
//   - Error reason rendered verbatim (Req 14.6).
//   - charCount uses Unicode code points, not UTF-16 units
//     (Req 9.3, 8.8).
//   - attachToBuffer triggers a re-render on the textarea `input`
//     event so the displayed count updates within the same tick
//     (Req 8.8).
//
// The Req 9.5 "model name updates within 200ms after save_settings"
// behaviour lives in main.js and is exercised in main.test.js / the
// integration suite; here we only assert that renderStatusBar
// synchronously reflects the model value passed in.

import { beforeEach, describe, expect, it } from "vitest";
import {
  renderStatusBar,
  attachToBuffer,
  formatStatusBar,
  _internal,
} from "../status_bar.js";

/** Install a minimal DOM the status bar reaches for. */
function installFooter() {
  document.body.innerHTML = `
    <textarea id="buffer"></textarea>
    <footer id="status-bar"></footer>
  `;
  return {
    buffer: document.getElementById("buffer"),
    footer: document.getElementById("status-bar"),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderStatusBar — path segment (Req 9.1, 9.2)", () => {
  it("falls back to 'Untitled' when path is null", () => {
    const { footer } = installFooter();
    renderStatusBar({ path: null, charCount: 0, model: "m", dirty: false });
    expect(footer.textContent.startsWith("Untitled")).toBe(true);
  });

  it("falls back to 'Untitled' when path is the empty string", () => {
    const { footer } = installFooter();
    renderStatusBar({ path: "", charCount: 0, model: "m", dirty: false });
    expect(footer.textContent.startsWith("Untitled")).toBe(true);
  });

  it("displays the absolute path verbatim when one is set", () => {
    const { footer } = installFooter();
    renderStatusBar({
      path: "/Users/alex/notes.md",
      charCount: 0,
      model: "m",
      dirty: false,
    });
    expect(footer.textContent.startsWith("/Users/alex/notes.md")).toBe(true);
  });
});

describe("renderStatusBar — dirty asterisk (Req 9.6, 9.7)", () => {
  it("prefixes the asterisk with no intervening characters before Untitled", () => {
    const { footer } = installFooter();
    renderStatusBar({ path: null, charCount: 0, model: "m", dirty: true });
    expect(footer.textContent.startsWith("*Untitled")).toBe(true);
    // Specifically: index 0 is '*', index 1 is 'U' — nothing between.
    expect(footer.textContent[0]).toBe("*");
    expect(footer.textContent[1]).toBe("U");
  });

  it("prefixes the asterisk immediately before a file path", () => {
    const { footer } = installFooter();
    renderStatusBar({
      path: "/tmp/a.txt",
      charCount: 0,
      model: "m",
      dirty: true,
    });
    expect(footer.textContent.startsWith("*/tmp/a.txt")).toBe(true);
    expect(footer.textContent[0]).toBe("*");
    expect(footer.textContent[1]).toBe("/");
  });

  it("omits the asterisk when not dirty (Req 9.7)", () => {
    const { footer } = installFooter();
    renderStatusBar({
      path: "/tmp/a.txt",
      charCount: 0,
      model: "m",
      dirty: false,
    });
    expect(footer.textContent.startsWith("/tmp/a.txt")).toBe(true);
    expect(footer.textContent.startsWith("*")).toBe(false);
  });
});

describe("renderStatusBar — model fallback (Req 9.4)", () => {
  it("renders '(no model)' when model is the empty string", () => {
    const { footer } = installFooter();
    renderStatusBar({ path: null, charCount: 0, model: "", dirty: false });
    expect(footer.textContent.includes("(no model)")).toBe(true);
  });

  it("renders '(no model)' when model is null", () => {
    const { footer } = installFooter();
    renderStatusBar({ path: null, charCount: 0, model: null, dirty: false });
    expect(footer.textContent.includes("(no model)")).toBe(true);
  });

  it("renders '(no model)' when model is undefined", () => {
    const { footer } = installFooter();
    renderStatusBar({ path: null, charCount: 0, dirty: false });
    expect(footer.textContent.includes("(no model)")).toBe(true);
  });

  it("renders the model value verbatim when provided", () => {
    const { footer } = installFooter();
    renderStatusBar({
      path: null,
      charCount: 0,
      model: "local-model",
      dirty: false,
    });
    expect(footer.textContent.includes("local-model")).toBe(true);
    expect(footer.textContent.includes("(no model)")).toBe(false);
  });
});

describe("renderStatusBar — character count (Req 9.3)", () => {
  it("shows the count as a non-negative integer with the 'chars' suffix", () => {
    const { footer } = installFooter();
    renderStatusBar({ path: null, charCount: 42, model: "m", dirty: false });
    expect(footer.textContent.includes("42 chars")).toBe(true);
  });

  it("clamps a negative or non-finite count to 0", () => {
    const { footer } = installFooter();
    renderStatusBar({ path: null, charCount: -5, model: "m", dirty: false });
    expect(footer.textContent.includes("0 chars")).toBe(true);

    renderStatusBar({ path: null, charCount: NaN, model: "m", dirty: false });
    expect(footer.textContent.includes("0 chars")).toBe(true);
  });
});

describe("renderStatusBar — error reason (Req 14.6)", () => {
  it("appends the error reason verbatim when present", () => {
    const { footer } = installFooter();
    renderStatusBar({
      path: null,
      charCount: 0,
      model: "m",
      dirty: false,
      error: "connection failed",
    });
    expect(footer.textContent.includes("connection failed")).toBe(true);
  });

  it("preserves multi-word error messages exactly as given (no transformation)", () => {
    const { footer } = installFooter();
    const reason = "settings could not be loaded; using defaults";
    renderStatusBar({
      path: null,
      charCount: 0,
      model: "m",
      dirty: false,
      error: reason,
    });
    expect(footer.textContent.includes(reason)).toBe(true);
  });

  it("omits the error segment when error is empty / null / undefined", () => {
    const { footer } = installFooter();
    renderStatusBar({
      path: null,
      charCount: 0,
      model: "local-model",
      dirty: false,
      error: "",
    });
    // No trailing error segment: the bar ends at the model name.
    expect(footer.textContent.endsWith("local-model")).toBe(true);

    renderStatusBar({
      path: null,
      charCount: 0,
      model: "local-model",
      dirty: false,
      error: null,
    });
    expect(footer.textContent.endsWith("local-model")).toBe(true);

    renderStatusBar({
      path: null,
      charCount: 0,
      model: "local-model",
      dirty: false,
      // error omitted entirely
    });
    expect(footer.textContent.endsWith("local-model")).toBe(true);
  });
});

describe("renderStatusBar — missing footer is a no-op", () => {
  it("does not throw when #status-bar is absent", () => {
    document.body.innerHTML = "";
    expect(() =>
      renderStatusBar({ path: null, charCount: 0, model: "m" })
    ).not.toThrow();
  });
});

describe("formatStatusBar — composite example", () => {
  it("includes path, count, and model in order with the documented separator", () => {
    const text = formatStatusBar({
      path: "/tmp/a.txt",
      charCount: 5,
      model: "local-model",
      dirty: true,
      line: 3,
      column: 25,
    });
    expect(text.startsWith("*/tmp/a.txt")).toBe(true);
    expect(text.includes("Ln 3, Col 25")).toBe(true);
    expect(text.includes("5 chars")).toBe(true);
    expect(text.includes("local-model")).toBe(true);
    expect(text.indexOf("/tmp/a.txt")).toBeLessThan(text.indexOf("5 chars"));
    expect(text.indexOf("5 chars")).toBeLessThan(text.indexOf("local-model"));
  });
});

describe("codePointLength helper (Req 9.3, 8.8)", () => {
  const { codePointLength } = _internal;

  it("returns 0 for the empty string", () => {
    expect(codePointLength("")).toBe(0);
  });

  it("counts ASCII characters as one each", () => {
    expect(codePointLength("hello")).toBe(5);
  });

  it("counts a single non-BMP code point as 1, not 2 UTF-16 units", () => {
    // U+1F600 (😀) — one code point, two UTF-16 code units.
    const s = "😀";
    expect(s.length).toBe(2); // sanity: UTF-16 units
    expect(codePointLength(s)).toBe(1);
  });

  it("counts mixed BMP / non-BMP correctly", () => {
    const s = "a😀b🎉c";
    expect(codePointLength(s)).toBe(5);
  });
});

describe("attachToBuffer — renders on input event (Req 8.8)", () => {
  it("re-renders synchronously on each input event with the live char count", () => {
    const { buffer, footer } = installFooter();
    const detach = attachToBuffer(buffer, () => ({
      path: null,
      model: "m",
      dirty: false,
      error: null,
    }));

    buffer.value = "hi";
    buffer.dispatchEvent(new Event("input"));
    expect(footer.textContent.includes("2 chars")).toBe(true);

    buffer.value = "hello!";
    buffer.dispatchEvent(new Event("input"));
    expect(footer.textContent.includes("6 chars")).toBe(true);

    detach();
  });

  it("uses code-point length on input, not UTF-16 unit length", () => {
    const { buffer, footer } = installFooter();
    const detach = attachToBuffer(buffer, () => ({
      path: null,
      model: "m",
      dirty: false,
    }));

    // 😀 is 2 UTF-16 code units but 1 code point.
    buffer.value = "😀😀😀";
    buffer.dispatchEvent(new Event("input"));
    expect(footer.textContent.includes("3 chars")).toBe(true);

    detach();
  });

  it("merges getState fields with the live char count", () => {
    const { buffer, footer } = installFooter();
    const detach = attachToBuffer(buffer, () => ({
      path: "/tmp/a.txt",
      model: "local-model",
      dirty: true,
      error: null,
    }));

    buffer.value = "abc";
    buffer.dispatchEvent(new Event("input"));

    expect(footer.textContent.startsWith("*/tmp/a.txt")).toBe(true);
    expect(footer.textContent.includes("3 chars")).toBe(true);
    expect(footer.textContent.includes("local-model")).toBe(true);

    detach();
  });

  it("returns a teardown function that detaches the listener", () => {
    const { buffer, footer } = installFooter();
    const detach = attachToBuffer(buffer, () => ({ model: "m" }));

    buffer.value = "abc";
    buffer.dispatchEvent(new Event("input"));
    expect(footer.textContent.includes("3 chars")).toBe(true);

    detach();
    footer.textContent = "untouched";
    buffer.value = "abcdef";
    buffer.dispatchEvent(new Event("input"));
    expect(footer.textContent).toBe("untouched");
  });

  it("falls back gracefully when getState throws or is omitted", () => {
    const { buffer, footer } = installFooter();
    const detach = attachToBuffer(buffer, () => {
      throw new Error("boom");
    });

    buffer.value = "abc";
    expect(() => buffer.dispatchEvent(new Event("input"))).not.toThrow();
    // Still rendered with defaults: Untitled / (no model).
    expect(footer.textContent.includes("Untitled")).toBe(true);
    expect(footer.textContent.includes("3 chars")).toBe(true);
    expect(footer.textContent.includes("(no model)")).toBe(true);

    detach();

    const detach2 = attachToBuffer(buffer);
    buffer.value = "abcd";
    expect(() => buffer.dispatchEvent(new Event("input"))).not.toThrow();
    expect(footer.textContent.includes("4 chars")).toBe(true);
    detach2();
  });

  it("returns a no-op teardown when given a falsy element", () => {
    const detach = attachToBuffer(null);
    expect(typeof detach).toBe("function");
    expect(() => detach()).not.toThrow();
  });
});
