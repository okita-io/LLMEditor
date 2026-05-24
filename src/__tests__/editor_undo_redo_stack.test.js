// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — editor.js undo/redo stack and edit-pipeline tests
// for Task 20.
//
// Coverage:
//   - `pushOnto` evicts FIFO at capacity 200 (Req 18.18-18.20).
//   - `pushUndo` clears `redoStack` from non-Redo sources (Req 18.15)
//     and preserves it when called with `{ fromRedo: true }`.
//   - `recordTypedKeystroke` coalesces fast keystrokes, breaks on
//     >1000ms gap, breaks on cursor-jump, breaks on Enter
//     (Req 18.2-18.4).
//   - Paste produces exactly one `EditGroup` (Req 18.5).
//   - Cut on a zero-length selection produces no group and is a
//     no-op (Req 8.4 + 18.6 precondition); cut on a non-zero-length
//     selection produces exactly one group (Req 18.6).
//   - The `tauri://file-opened` resolution path (`_replaceBufferOnOpen`)
//     clears both stacks (Req 18.16).
//   - `saveFile` and `saveFileAs` leave both stacks untouched on
//     every code path (Req 18.17).

import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as editor from "../editor.js";

function installBuffer(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  return el;
}

function makeChange({
  at = 0,
  deleted = "",
  inserted = "x",
  beforeStart = 0,
  beforeEnd = 0,
  afterStart = 1,
  afterEnd = 1,
} = {}) {
  return {
    at,
    deleted,
    inserted,
    beforeSelection: { start: beforeStart, end: beforeEnd },
    afterSelection: { start: afterStart, end: afterEnd },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pushOnto FIFO eviction (Req 18.18-18.20)", () => {
  it("keeps the stack bounded to the documented capacity with FIFO eviction", () => {
    installBuffer("");
    editor.initialize();
    const { capacity } = editor._undoRedoStateForTests();
    expect(capacity).toBe(200);

    // Push 250 distinct typing groups directly via the internal
    // helpers so we drive the FIFO rule without timing concerns.
    for (let i = 0; i < 250; i += 1) {
      editor._undoRedoInternals.pushUndo({
        source: "typing",
        beforeSelection: { start: i, end: i },
        afterSelection: { start: i + 1, end: i + 1 },
        changes: [{ at: i, deleted: "", inserted: String(i) }],
        lastAppendedAt: i,
      });
    }

    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(200);
    // After 250 pushes with capacity 200, the surviving entries are
    // the last 200 (indices 50..249); the bottom-most surviving
    // entry is the 51st pushed (i === 50).
    expect(undoStack[0].changes[0].inserted).toBe("50");
    expect(undoStack[199].changes[0].inserted).toBe("249");
  });
});

describe("pushUndo redo-stack clear semantics (Req 18.15)", () => {
  it("clears redoStack on a non-Redo push", () => {
    installBuffer("");
    editor.initialize();

    editor._setRedoStackForTests([
      { source: "typing", beforeSelection: {start:0,end:0}, afterSelection: {start:0,end:0}, changes: [], lastAppendedAt: 0 },
    ]);
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(1);

    editor._undoRedoInternals.pushUndo({
      source: "typing",
      beforeSelection: { start: 0, end: 0 },
      afterSelection: { start: 1, end: 1 },
      changes: [{ at: 0, deleted: "", inserted: "a" }],
      lastAppendedAt: 0,
    });

    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(0);
  });

  it("preserves redoStack when pushUndo is called with fromRedo: true (Task 21 hook)", () => {
    installBuffer("");
    editor.initialize();
    editor._setRedoStackForTests([
      { source: "typing", beforeSelection: {start:0,end:0}, afterSelection: {start:0,end:0}, changes: [], lastAppendedAt: 0 },
      { source: "paste",  beforeSelection: {start:0,end:0}, afterSelection: {start:0,end:0}, changes: [], lastAppendedAt: 0 },
    ]);

    editor._undoRedoInternals.pushUndo(
      {
        source: "typing",
        beforeSelection: { start: 0, end: 0 },
        afterSelection: { start: 1, end: 1 },
        changes: [{ at: 0, deleted: "", inserted: "a" }],
        lastAppendedAt: 0,
      },
      { fromRedo: true }
    );

    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(2);
  });
});

describe("recordTypedKeystroke grouping (Req 18.2-18.4)", () => {
  it("appends to the top group when the four append-conditions hold (Req 18.2)", () => {
    installBuffer("");
    editor.initialize();
    const t0 = 1000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    editor.recordTypedKeystroke({ key: "a" }, makeChange({ inserted: "a", afterStart: 1, afterEnd: 1 }));

    Date.now.mockReturnValue(t0 + 100);
    editor.recordTypedKeystroke(
      { key: "b" },
      makeChange({ at: 1, inserted: "b", beforeStart: 1, beforeEnd: 1, afterStart: 2, afterEnd: 2 })
    );

    Date.now.mockReturnValue(t0 + 200);
    editor.recordTypedKeystroke(
      { key: "c" },
      makeChange({ at: 2, inserted: "c", beforeStart: 2, beforeEnd: 2, afterStart: 3, afterEnd: 3 })
    );

    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].source).toBe("typing");
    expect(undoStack[0].changes).toEqual([
      { at: 0, deleted: "", inserted: "a" },
      { at: 1, deleted: "", inserted: "b" },
      { at: 2, deleted: "", inserted: "c" },
    ]);
    expect(undoStack[0].afterSelection).toEqual({ start: 3, end: 3 });
  });

  it("breaks the group when more than 1000ms has passed since the last append (Req 18.2)", () => {
    installBuffer("");
    editor.initialize();
    const t0 = 1000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    editor.recordTypedKeystroke({ key: "a" }, makeChange({ inserted: "a" }));

    Date.now.mockReturnValue(t0 + 1001);
    editor.recordTypedKeystroke(
      { key: "b" },
      makeChange({ at: 1, inserted: "b", beforeStart: 1, beforeEnd: 1, afterStart: 2, afterEnd: 2 })
    );

    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(2);
    expect(undoStack[0].changes[0].inserted).toBe("a");
    expect(undoStack[1].changes[0].inserted).toBe("b");
  });

  it("coalesces a keystroke arriving exactly 1000ms after the previous (boundary inclusive)", () => {
    installBuffer("");
    editor.initialize();
    const t0 = 1000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    editor.recordTypedKeystroke({ key: "a" }, makeChange({ inserted: "a" }));

    Date.now.mockReturnValue(t0 + 1000);
    editor.recordTypedKeystroke(
      { key: "b" },
      makeChange({ at: 1, inserted: "b", beforeStart: 1, beforeEnd: 1, afterStart: 2, afterEnd: 2 })
    );

    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].changes).toHaveLength(2);
  });

  it("breaks the group when cursorJumped is set between keystrokes (Req 18.2)", () => {
    installBuffer("");
    editor.initialize();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    editor.recordTypedKeystroke({ key: "a" }, makeChange({ inserted: "a" }));

    editor._setCursorJumpedForTests(true);
    Date.now.mockReturnValue(1100);
    editor.recordTypedKeystroke(
      { key: "b" },
      makeChange({ at: 5, inserted: "b", beforeStart: 5, beforeEnd: 5, afterStart: 6, afterEnd: 6 })
    );

    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(2);
  });

  it("Enter always begins a new group and clears cursorJumped afterwards (Req 18.4)", () => {
    installBuffer("");
    editor.initialize();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    editor.recordTypedKeystroke({ key: "a" }, makeChange({ inserted: "a" }));
    editor.recordTypedKeystroke(
      { key: "b" },
      makeChange({ at: 1, inserted: "b", beforeStart: 1, beforeEnd: 1, afterStart: 2, afterEnd: 2 })
    );

    Date.now.mockReturnValue(1100);
    editor.recordTypedKeystroke(
      { key: "Enter" },
      makeChange({ at: 2, inserted: "\n", beforeStart: 2, beforeEnd: 2, afterStart: 3, afterEnd: 3 })
    );

    let { undoStack, cursorJumped } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(2);
    expect(undoStack[1].source).toBe("typing");
    expect(undoStack[1].changes).toEqual([{ at: 2, deleted: "", inserted: "\n" }]);
    // Enter clears `cursorJumped` afterwards so the next typed
    // keystroke can coalesce with the Enter group.
    expect(cursorJumped).toBe(false);

    Date.now.mockReturnValue(1200);
    editor.recordTypedKeystroke(
      { key: "c" },
      makeChange({ at: 3, inserted: "c", beforeStart: 3, beforeEnd: 3, afterStart: 4, afterEnd: 4 })
    );
    ({ undoStack } = editor._undoRedoStateForTests());
    expect(undoStack).toHaveLength(2);
    expect(undoStack[1].changes).toEqual([
      { at: 2, deleted: "", inserted: "\n" },
      { at: 3, deleted: "", inserted: "c" },
    ]);
  });

  it("does not record while a Stream is active (Req 18.21)", () => {
    installBuffer("");
    editor.initialize();
    editor._beginStream("insert_at_cursor");
    vi.spyOn(Date, "now").mockReturnValue(1000);
    editor.recordTypedKeystroke({ key: "a" }, makeChange({ inserted: "a" }));

    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    editor._endStream();
  });
});

describe("paste handler (Req 18.5)", () => {
  it("pushes a single paste-sourced EditGroup with the splice", () => {
    const el = installBuffer("hello world");
    editor.initialize();
    el.selectionStart = 6;
    el.selectionEnd = 11; // selecting "world"

    const cd = {
      _store: { "text/plain": "FRIENDS" },
      getData(t) {
        return this._store[t] || "";
      },
    };
    const event = new Event("paste");
    Object.defineProperty(event, "clipboardData", { value: cd });
    el.dispatchEvent(event);

    expect(el.value).toBe("hello FRIENDS");
    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].source).toBe("paste");
    expect(undoStack[0].changes).toEqual([
      { at: 6, deleted: "world", inserted: "FRIENDS" },
    ]);
    expect(undoStack[0].beforeSelection).toEqual({ start: 6, end: 11 });
    expect(undoStack[0].afterSelection).toEqual({ start: 13, end: 13 });
  });

  it("paste with empty clipboard text produces no group and no mutation", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.selectionStart = 5;
    el.selectionEnd = 5;

    const cd = {
      getData() {
        return "";
      },
    };
    const event = new Event("paste");
    Object.defineProperty(event, "clipboardData", { value: cd });
    el.dispatchEvent(event);

    expect(el.value).toBe("hello");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
  });

  it("paste with no selection inserts at the caret (Req 8.5)", () => {
    const el = installBuffer("abc");
    editor.initialize();
    el.selectionStart = 1;
    el.selectionEnd = 1;
    const cd = {
      _store: { "text/plain": "XY" },
      getData(t) { return this._store[t] || ""; },
    };
    const event = new Event("paste");
    Object.defineProperty(event, "clipboardData", { value: cd });
    el.dispatchEvent(event);

    expect(el.value).toBe("aXYbc");
    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].changes).toEqual([
      { at: 1, deleted: "", inserted: "XY" },
    ]);
  });

  it("paste clears redoStack via pushUndo (Req 18.15)", () => {
    const el = installBuffer("");
    editor.initialize();
    editor._setRedoStackForTests([
      { source: "typing", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [], lastAppendedAt: 0 },
    ]);

    el.selectionStart = 0;
    el.selectionEnd = 0;
    const cd = {
      _store: { "text/plain": "abc" },
      getData(t) { return this._store[t] || ""; },
    };
    const event = new Event("paste");
    Object.defineProperty(event, "clipboardData", { value: cd });
    el.dispatchEvent(event);

    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(0);
  });
});

describe("cut handler (Req 8.4 + 18.6)", () => {
  it("zero-length selection cut is a no-op and produces no group (Req 8.4 + 18.6)", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.selectionStart = 2;
    el.selectionEnd = 2;

    const cd = {
      _store: {},
      setData(t, v) { this._store[t] = v; },
    };
    const event = new Event("cut");
    Object.defineProperty(event, "clipboardData", { value: cd });
    el.dispatchEvent(event);

    expect(el.value).toBe("hello");
    expect(cd._store["text/plain"]).toBeUndefined();
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
  });

  it("non-zero selection cut splices the selection out and pushes one group (Req 18.6)", () => {
    const el = installBuffer("hello world");
    editor.initialize();
    el.selectionStart = 6;
    el.selectionEnd = 11;

    const cd = {
      _store: {},
      setData(t, v) { this._store[t] = v; },
    };
    const event = new Event("cut");
    Object.defineProperty(event, "clipboardData", { value: cd });
    el.dispatchEvent(event);

    expect(el.value).toBe("hello ");
    expect(cd._store["text/plain"]).toBe("world");
    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].source).toBe("cut");
    expect(undoStack[0].changes).toEqual([
      { at: 6, deleted: "world", inserted: "" },
    ]);
    expect(undoStack[0].beforeSelection).toEqual({ start: 6, end: 11 });
    expect(undoStack[0].afterSelection).toEqual({ start: 6, end: 6 });
  });
});

describe("Open File / Save semantics (Req 18.16, 18.17)", () => {
  it("_replaceBufferOnOpen clears both undo and redo stacks (Req 18.16)", () => {
    installBuffer("");
    editor.initialize();

    editor._setUndoStackForTests([
      { source: "typing", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [], lastAppendedAt: 0 },
      { source: "paste",  beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [], lastAppendedAt: 0 },
    ]);
    editor._setRedoStackForTests([
      { source: "cut", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [], lastAppendedAt: 0 },
    ]);

    editor._replaceBufferOnOpen("loaded contents", "/tmp/foo.txt");

    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(0);
    expect(redoStack).toHaveLength(0);
    const state = editor._stateForTests();
    expect(state.savedSnapshot).toBe("loaded contents");
    expect(state.currentPath).toBe("/tmp/foo.txt");
    expect(editor.isDirty()).toBe(false);
  });

  it("openFile() routes through api.openFile and clears stacks on success (Req 18.16)", async () => {
    const el = installBuffer("");
    editor.initialize();
    editor._setUndoStackForTests([
      { source: "typing", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [], lastAppendedAt: 0 },
    ]);

    globalThis.__TAURI__ = {
      core: {
        invoke: async (cmd, args) => {
          expect(cmd).toBe("open_file");
          expect(args).toEqual({ path: "/tmp/x.txt" });
          return "from disk";
        },
      },
    };

    await editor.openFile("/tmp/x.txt");

    expect(el.value).toBe("from disk");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    delete globalThis.__TAURI__;
  });

  it("saveFile() leaves both stacks untouched on success (Req 18.17)", async () => {
    const el = installBuffer("buffered text");
    editor.initialize();
    editor._setUndoStackForTests([
      { source: "typing", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [{ at: 0, deleted: "", inserted: "x" }], lastAppendedAt: 0 },
    ]);
    editor._setRedoStackForTests([
      { source: "paste", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [{ at: 0, deleted: "", inserted: "y" }], lastAppendedAt: 0 },
    ]);
    // Set currentPath via a successful open so saveFile has a target.
    editor._replaceBufferOnOpen("buffered text", "/tmp/x.txt");
    // Re-seed undo/redo since _replaceBufferOnOpen cleared them.
    editor._setUndoStackForTests([
      { source: "typing", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [{ at: 0, deleted: "", inserted: "x" }], lastAppendedAt: 0 },
    ]);
    editor._setRedoStackForTests([
      { source: "paste", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [{ at: 0, deleted: "", inserted: "y" }], lastAppendedAt: 0 },
    ]);
    el.value = "edited";

    globalThis.__TAURI__ = {
      core: {
        invoke: async (cmd) => {
          expect(cmd).toBe("save_file");
          return undefined;
        },
      },
    };

    await editor.saveFile();

    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(redoStack).toHaveLength(1);
    delete globalThis.__TAURI__;
  });

  it("saveFile() leaves both stacks untouched on a failed write (Req 18.17)", async () => {
    const el = installBuffer("");
    editor.initialize();
    editor._replaceBufferOnOpen("buffered", "/tmp/x.txt");
    editor._setUndoStackForTests([
      { source: "typing", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [{ at: 0, deleted: "", inserted: "x" }], lastAppendedAt: 0 },
    ]);
    editor._setRedoStackForTests([
      { source: "paste", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [{ at: 0, deleted: "", inserted: "y" }], lastAppendedAt: 0 },
    ]);
    el.value = "edited";

    globalThis.__TAURI__ = {
      core: {
        invoke: async () => {
          throw "could not save file: denied";
        },
      },
    };

    await editor.saveFile();

    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(redoStack).toHaveLength(1);
    delete globalThis.__TAURI__;
  });

  it("saveFileAs() leaves both stacks untouched (Req 18.17)", async () => {
    installBuffer("");
    editor.initialize();
    editor._setUndoStackForTests([
      { source: "typing", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [{ at: 0, deleted: "", inserted: "x" }], lastAppendedAt: 0 },
    ]);
    editor._setRedoStackForTests([
      { source: "paste", beforeSelection:{start:0,end:0}, afterSelection:{start:0,end:0}, changes: [{ at: 0, deleted: "", inserted: "y" }], lastAppendedAt: 0 },
    ]);

    await editor.saveFileAs();

    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(redoStack).toHaveLength(1);
  });
});

describe("copy handler (Req 8.3, 8.4)", () => {
  it("zero-length selection copy is a no-op and produces no group", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.selectionStart = 2;
    el.selectionEnd = 2;

    const cd = {
      _store: {},
      setData(t, v) { this._store[t] = v; },
    };
    const event = new Event("copy");
    Object.defineProperty(event, "clipboardData", { value: cd });
    el.dispatchEvent(event);

    expect(el.value).toBe("hello");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
  });

  it("non-zero copy does not push any EditGroup (copy is non-mutating)", () => {
    const el = installBuffer("hello world");
    editor.initialize();
    el.selectionStart = 0;
    el.selectionEnd = 5;

    const cd = {
      _store: {},
      setData(t, v) { this._store[t] = v; },
    };
    const event = new Event("copy");
    Object.defineProperty(event, "clipboardData", { value: cd });
    el.dispatchEvent(event);

    expect(el.value).toBe("hello world");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
  });
});

describe("cursor-jump signal wiring", () => {
  it("ArrowUp/Down/Left/Right keydown sets cursorJumped (Req 18.2)", () => {
    const el = installBuffer("hello");
    editor.initialize();
    expect(editor._undoRedoStateForTests().cursorJumped).toBe(false);

    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(editor._undoRedoStateForTests().cursorJumped).toBe(true);

    editor._setCursorJumpedForTests(false);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(editor._undoRedoStateForTests().cursorJumped).toBe(true);
  });

  it.each(["Home", "End", "PageUp", "PageDown"])(
    "%s keydown sets cursorJumped (Req 18.2)",
    (key) => {
      const el = installBuffer("hello");
      editor.initialize();
      el.dispatchEvent(new KeyboardEvent("keydown", { key }));
      expect(editor._undoRedoStateForTests().cursorJumped).toBe(true);
    }
  );

  it("mousedown on the textarea sets cursorJumped (Req 18.2)", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.dispatchEvent(new MouseEvent("mousedown"));
    expect(editor._undoRedoStateForTests().cursorJumped).toBe(true);
  });

  it("click on the textarea sets cursorJumped (Req 18.2)", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.dispatchEvent(new MouseEvent("click"));
    expect(editor._undoRedoStateForTests().cursorJumped).toBe(true);
  });

  it("a select event reflecting a different selection sets cursorJumped (Req 18.2)", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.selectionStart = 2;
    el.selectionEnd = 4;
    el.dispatchEvent(new Event("select"));
    expect(editor._undoRedoStateForTests().cursorJumped).toBe(true);
  });
});
