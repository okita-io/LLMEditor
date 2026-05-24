// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — editor.js unit tests.
//
// Covers the Task 18 surface:
//   - `initialize()` binds the `<textarea id="buffer">` and resets
//     module state to documented defaults.
//   - `isDirty()` is false when the buffer matches its saved snapshot
//     and true otherwise (Req 8.6, 8.7).
//   - `applyLLMResponse(mode, fragment)` synchronously throws on any
//     `mode` outside the three allowed strings *before* mutating the
//     buffer (Req 16.3).
//   - `applyLLMResponse` dispatches a synthetic `input` event so the
//     Status_Bar character-count handler sees every applied fragment
//     (Req 8.8).
//   - The three insertion-mode appliers operate correctly on a small
//     scenario per branch (Req 13.2, 13.3, 13.4) — exhaustive
//     property-based coverage lives in tasks 18.1-18.5.
//
// The full property-based coverage (P7-P11) lives in
// `editor.insert_at_cursor.test.js`, `editor.replace_selection.test.js`,
// `editor.replace_document.test.js`, `editor.dirty_flag.test.js`, and
// `editor.apply_response.test.js` once Tasks 18.1-18.5 land.

import { beforeEach, describe, expect, it } from "vitest";
import * as editor from "../editor.js";

/** Build the minimal DOM the editor module reaches for. */
function installBuffer(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("editor.initialize", () => {
  it("binds the textarea and resets state to documented defaults", () => {
    installBuffer("hello");

    editor.initialize();

    expect(editor._bufferElForTests()).not.toBeNull();
    expect(editor._bufferElForTests().tagName).toBe("TEXTAREA");
    const state = editor._stateForTests();
    expect(state.currentPath).toBeNull();
    expect(state.hadBom).toBe(false);
    expect(state.lineEnding).toBe("none");
    expect(state.streamActive).toBe(false);
    // savedSnapshot mirrors the textarea value at bind time so a
    // freshly bound buffer is not dirty.
    expect(state.savedSnapshot).toBe("hello");
    expect(editor._streamAnchorForTests()).toBeNull();
  });

  it("returns null from _bufferElForTests when no #buffer exists", () => {
    document.body.innerHTML = "";
    editor.initialize();
    expect(editor._bufferElForTests()).toBeNull();
  });
});

describe("editor.isDirty", () => {
  it("is false when the buffer matches the saved snapshot", () => {
    installBuffer("hello");
    editor.initialize();

    expect(editor.isDirty()).toBe(false);
  });

  it("is true after a buffer mutation that diverges from the snapshot", () => {
    const el = installBuffer("hello");
    editor.initialize();

    el.value = "hello world";

    expect(editor.isDirty()).toBe(true);
  });

  it("returns to false when the buffer is restored to the saved snapshot (Req 8.7)", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.value = "hello world";
    expect(editor.isDirty()).toBe(true);

    el.value = "hello";

    expect(editor.isDirty()).toBe(false);
  });

  it("is false before initialize() has bound any buffer", () => {
    document.body.innerHTML = "";
    editor.initialize(); // resets bufferEl to null
    expect(editor.isDirty()).toBe(false);
  });
});

describe("editor.applyLLMResponse — mode validation (Req 16.3)", () => {
  beforeEach(() => {
    installBuffer("seed");
    editor.initialize();
  });

  it("throws synchronously for an unknown mode string", () => {
    expect(() => editor.applyLLMResponse("nope", "x")).toThrow(
      /invalid Insertion_Mode/
    );
  });

  it.each([null, undefined, 0, false, {}, ["insert_at_cursor"]])(
    "throws synchronously for non-string mode %p",
    (mode) => {
      expect(() => editor.applyLLMResponse(mode, "x")).toThrow(
        /invalid Insertion_Mode/
      );
    }
  );

  it("does not mutate the buffer when the mode is invalid", () => {
    const el = editor._bufferElForTests();
    const before = el.value;
    expect(() => editor.applyLLMResponse("bogus", "ignored")).toThrow();
    expect(el.value).toBe(before);
    // Anchor is also untouched: validation runs before any
    // lazy-init path.
    expect(editor._streamAnchorForTests()).toBeNull();
  });

  it("accepts each of the three documented modes without throwing", () => {
    for (const mode of [
      "insert_at_cursor",
      "replace_selection",
      "replace_document",
    ]) {
      installBuffer("seed");
      editor.initialize();
      expect(() => editor.applyLLMResponse(mode, "x")).not.toThrow();
    }
  });
});

describe("editor.applyLLMResponse — dispatches input event (Req 8.8)", () => {
  it("dispatches an input event after each applied fragment", () => {
    const el = installBuffer("");
    editor.initialize();
    let inputEvents = 0;
    el.addEventListener("input", () => {
      inputEvents += 1;
    });

    editor.applyLLMResponse("insert_at_cursor", "a");
    editor.applyLLMResponse("insert_at_cursor", "b");
    editor.applyLLMResponse("insert_at_cursor", "c");

    expect(inputEvents).toBe(3);
    expect(el.value).toBe("abc");
  });
});

describe("editor.applyInsertAtCursor (Req 13.2)", () => {
  it("inserts each fragment at the captured cursor and advances the anchor", () => {
    const el = installBuffer("ab");
    editor.initialize();
    el.selectionStart = 1;
    el.selectionEnd = 1;
    editor._beginStream("insert_at_cursor");

    editor.applyLLMResponse("insert_at_cursor", "X");
    editor.applyLLMResponse("insert_at_cursor", "Y");
    editor.applyLLMResponse("insert_at_cursor", "Z");

    expect(el.value).toBe("aXYZb");
    const anchor = editor._streamAnchorForTests();
    expect(anchor.startCursor).toBe(1);
    expect(anchor.insertedLength).toBe(3);
  });

  it("counts code points (not UTF-16 code units) when advancing the anchor", () => {
    const el = installBuffer("");
    editor.initialize();
    editor._beginStream("insert_at_cursor");

    // U+1F600 (😀) is one code point but two UTF-16 code units.
    editor.applyLLMResponse("insert_at_cursor", "😀");

    const anchor = editor._streamAnchorForTests();
    expect(anchor.insertedLength).toBe(1);
    expect(el.value).toBe("😀");
  });
});

describe("editor.applyReplaceSelection (Req 13.3)", () => {
  it("replaces the captured selection on the first token, appends after", () => {
    const el = installBuffer("hello world");
    editor.initialize();
    // Select "world".
    el.selectionStart = 6;
    el.selectionEnd = 11;
    editor._beginStream("replace_selection");

    editor.applyLLMResponse("replace_selection", "FOO");
    editor.applyLLMResponse("replace_selection", "BAR");

    expect(el.value).toBe("hello FOOBAR");
    const anchor = editor._streamAnchorForTests();
    expect(anchor.insertedLength).toBe(6);
  });

  it("collapses to insert-at-cursor when the captured selection is empty", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.selectionStart = 5;
    el.selectionEnd = 5;
    editor._beginStream("replace_selection");

    editor.applyLLMResponse("replace_selection", "!");
    editor.applyLLMResponse("replace_selection", "?");

    expect(el.value).toBe("hello!?");
  });
});

describe("editor.applyReplaceDocument (Req 13.4)", () => {
  it("replaces the buffer on the first token and appends on subsequent tokens", () => {
    const el = installBuffer("seed contents");
    editor.initialize();
    editor._beginStream("replace_document");

    editor.applyLLMResponse("replace_document", "Hello");
    editor.applyLLMResponse("replace_document", " ");
    editor.applyLLMResponse("replace_document", "world");

    expect(el.value).toBe("Hello world");
    const anchor = editor._streamAnchorForTests();
    expect(anchor.insertedLength).toBe(11);
  });

  it("records the prior contents as deleted on the first token", () => {
    installBuffer("prior");
    editor.initialize();
    editor._beginStream("replace_document");

    editor.applyLLMResponse("replace_document", "next");

    const anchor = editor._streamAnchorForTests();
    expect(anchor.group.changes).toHaveLength(1);
    expect(anchor.group.changes[0]).toEqual({
      at: 0,
      deleted: "prior",
      inserted: "next",
    });
  });
});

describe("editor stream lifecycle", () => {
  it("_beginStream / _endStream toggle streamActive and clear the anchor", () => {
    installBuffer("");
    editor.initialize();
    expect(editor._stateForTests().streamActive).toBe(false);

    editor._beginStream("insert_at_cursor");
    expect(editor._stateForTests().streamActive).toBe(true);
    expect(editor._streamAnchorForTests()).not.toBeNull();

    editor._endStream();
    expect(editor._stateForTests().streamActive).toBe(false);
    expect(editor._streamAnchorForTests()).toBeNull();
  });

  it("applyLLMResponse lazy-inits the anchor when no stream is active", () => {
    const el = installBuffer("");
    editor.initialize();
    expect(editor._streamAnchorForTests()).toBeNull();

    editor.applyLLMResponse("insert_at_cursor", "x");

    expect(el.value).toBe("x");
    expect(editor._streamAnchorForTests()).not.toBeNull();
  });
});
