// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as editor from "../editor.js";

function installBuffer(initialValue = "hello") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  editor.initialize();
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("editor tab → spaces", () => {
  it("inserts 4 spaces by default when Tab is pressed", () => {
    const el = installBuffer("ab");
    el.selectionStart = 2;
    el.selectionEnd = 2;

    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );

    expect(el.value).toBe("ab    ");
    expect(el.selectionStart).toBe(6);
  });

  it("inserts 2 spaces when tab_spaces is 2", () => {
    const el = installBuffer("x");
    editor.applyEditorSettings({ tab_spaces: 2 });
    el.selectionStart = 1;
    el.selectionEnd = 1;

    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );

    expect(el.value).toBe("x  ");
  });

  it("replaces the selection with spaces", () => {
    const el = installBuffer("hello world");
    editor.applyEditorSettings({ tab_spaces: 4 });
    el.selectionStart = 6;
    el.selectionEnd = 11;

    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );

    expect(el.value).toBe("hello     ");
  });

  it("undo reverts a tab insertion", () => {
    const el = installBuffer("a");
    el.selectionStart = 1;
    el.selectionEnd = 1;

    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    );
    expect(el.value).toBe("a    ");

    editor.undo();
    expect(el.value).toBe("a");
  });
});
