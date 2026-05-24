// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — editor.js undo() / redo() / stream-group lifecycle /
// `beforeinput` interceptor tests for Task 21.
//
// Coverage:
//   - undo() with empty stack is a no-op (Req 18.12).
//   - undo() pops, reverts, restores beforeSelection, pushes onto
//     redoStack, dispatches `input` (Req 18.11).
//   - undo() + redo() round-trip on a single typing group is the
//     identity (Req 18.11 + 18.13).
//   - Multiple alternating undo()/redo() cycles preserve the buffer
//     and stack invariants (Req 18.11, 18.13).
//   - undo() while a stream is active is a no-op (Req 18.21).
//   - redo() while a stream is active is a no-op (Req 18.21).
//   - Bounds-check fallback: a corrupted change.deleted leaves both
//     stacks unchanged, the popped group is re-pushed, and
//     `console.error` is called.
//   - The `beforeinput` interceptor routes `inputType === "historyUndo"`
//     and `inputType === "historyRedo"` to undo()/redo() with
//     preventDefault.
//   - `_completeStream()` with `changes.length >= 1` pushes the
//     stream group onto undoStack with the post-stream selection as
//     `afterSelection` (Req 18.7, 18.8, 18.9, 18.10).
//   - `_completeStream()` with `changes.length === 0` does NOT push
//     (Req 18.10 precondition).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as editor from "../editor.js";

function installBuffer(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  return el;
}

function makeTypingGroup({
  before = "",
  after = "x",
  at = 0,
  deleted = "",
  inserted = "x",
  beforeStart = 0,
  beforeEnd = 0,
  afterStart = 1,
  afterEnd = 1,
} = {}) {
  // `before` and `after` are not stored on the group; they are
  // included so callers can see the buffer pre/post state in the
  // test setup at a glance.
  void before;
  void after;
  return {
    source: "typing",
    beforeSelection: { start: beforeStart, end: beforeEnd },
    afterSelection: { start: afterStart, end: afterEnd },
    changes: [{ at, deleted, inserted }],
    lastAppendedAt: 0,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("undo() empty-stack and stream-active gating", () => {
  it("is a no-op when the undoStack is empty (Req 18.12)", () => {
    const el = installBuffer("hello");
    editor.initialize();
    el.value = "hello";

    editor.undo();

    expect(el.value).toBe("hello");
    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(0);
    expect(redoStack).toHaveLength(0);
  });

  it("is a no-op while a stream is active (Req 18.21)", () => {
    const el = installBuffer("hello");
    editor.initialize();
    editor._setUndoStackForTests([
      makeTypingGroup({ at: 5, deleted: "", inserted: "!" }),
    ]);
    el.value = "hello!";
    editor._beginStream("insert_at_cursor");

    editor.undo();

    expect(el.value).toBe("hello!");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(1);
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(0);
    editor._endStream();
  });
});

describe("undo() reverts and pushes onto redoStack (Req 18.11)", () => {
  it("reverts a single typing-group change and restores beforeSelection", () => {
    const el = installBuffer("hi!");
    editor.initialize();
    // Pre-state: "hi" with caret at end (position 2). User typed "!".
    // Post-state: "hi!" with caret at 3.
    editor._setUndoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 2, end: 2 },
        afterSelection: { start: 3, end: 3 },
        changes: [{ at: 2, deleted: "", inserted: "!" }],
        lastAppendedAt: 0,
      },
    ]);

    let inputDispatched = false;
    el.addEventListener("input", () => {
      inputDispatched = true;
    });

    editor.undo();

    expect(el.value).toBe("hi");
    expect(el.selectionStart).toBe(2);
    expect(el.selectionEnd).toBe(2);
    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(0);
    expect(redoStack).toHaveLength(1);
    expect(redoStack[0].source).toBe("typing");
    expect(inputDispatched).toBe(true);
  });

  it("reverts multi-change groups in reverse order", () => {
    const el = installBuffer("abc");
    editor.initialize();
    // Group has two changes: insert "a" at 0 then insert "b" at 1
    // then insert "c" at 2 — all coalesced into one typing group.
    editor._setUndoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 0, end: 0 },
        afterSelection: { start: 3, end: 3 },
        changes: [
          { at: 0, deleted: "", inserted: "a" },
          { at: 1, deleted: "", inserted: "b" },
          { at: 2, deleted: "", inserted: "c" },
        ],
        lastAppendedAt: 0,
      },
    ]);

    editor.undo();

    expect(el.value).toBe("");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(1);
  });

  it("reverts a paste-group splice losslessly", () => {
    const el = installBuffer("hello FRIENDS");
    editor.initialize();
    editor._setUndoStackForTests([
      {
        source: "paste",
        beforeSelection: { start: 6, end: 11 },
        afterSelection: { start: 13, end: 13 },
        changes: [{ at: 6, deleted: "world", inserted: "FRIENDS" }],
        lastAppendedAt: 0,
      },
    ]);

    editor.undo();

    expect(el.value).toBe("hello world");
    expect(el.selectionStart).toBe(6);
    expect(el.selectionEnd).toBe(11);
  });
});

describe("undo() + redo() round-trip identity (Req 18.11, 18.13)", () => {
  it("a single undo/redo on a typing group restores the buffer to its post-edit state", () => {
    const el = installBuffer("hi!");
    editor.initialize();
    editor._setUndoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 2, end: 2 },
        afterSelection: { start: 3, end: 3 },
        changes: [{ at: 2, deleted: "", inserted: "!" }],
        lastAppendedAt: 0,
      },
    ]);

    editor.undo();
    expect(el.value).toBe("hi");
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(1);

    editor.redo();
    expect(el.value).toBe("hi!");
    expect(el.selectionStart).toBe(3);
    expect(el.selectionEnd).toBe(3);
    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(redoStack).toHaveLength(0);
  });

  it("multiple alternating undo/redo cycles converge on the same end state", () => {
    const el = installBuffer("hi!");
    editor.initialize();
    const group = {
      source: "typing",
      beforeSelection: { start: 2, end: 2 },
      afterSelection: { start: 3, end: 3 },
      changes: [{ at: 2, deleted: "", inserted: "!" }],
      lastAppendedAt: 0,
    };
    editor._setUndoStackForTests([group]);

    for (let i = 0; i < 5; i += 1) {
      editor.undo();
      expect(el.value).toBe("hi");
      editor.redo();
      expect(el.value).toBe("hi!");
    }
  });

  it("redo() does NOT clear redoStack (Req 18.13: pushUndo with fromRedo: true)", () => {
    const el = installBuffer("");
    editor.initialize();
    // Stage two groups on the undoStack representing "type a" then
    // "type b". Then do two undos so both land on redoStack, then
    // redo once and verify the second group still sits on
    // redoStack.
    el.value = "ab";
    editor._setUndoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 0, end: 0 },
        afterSelection: { start: 1, end: 1 },
        changes: [{ at: 0, deleted: "", inserted: "a" }],
        lastAppendedAt: 0,
      },
      {
        source: "typing",
        beforeSelection: { start: 1, end: 1 },
        afterSelection: { start: 2, end: 2 },
        changes: [{ at: 1, deleted: "", inserted: "b" }],
        lastAppendedAt: 0,
      },
    ]);

    editor.undo(); // pops "b" group, buffer "a"
    editor.undo(); // pops "a" group, buffer ""
    expect(el.value).toBe("");
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(2);

    editor.redo(); // re-applies "a"
    expect(el.value).toBe("a");
    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    // Redo MUST preserve the rest of redoStack (Req 18.13).
    expect(redoStack).toHaveLength(1);
    expect(redoStack[0].changes[0].inserted).toBe("b");
  });
});

describe("redo() empty-stack and stream-active gating", () => {
  it("is a no-op when the redoStack is empty (Req 18.14)", () => {
    const el = installBuffer("abc");
    editor.initialize();
    el.value = "abc";

    editor.redo();

    expect(el.value).toBe("abc");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(0);
  });

  it("is a no-op while a stream is active (Req 18.21)", () => {
    const el = installBuffer("a");
    editor.initialize();
    editor._setRedoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 1, end: 1 },
        afterSelection: { start: 2, end: 2 },
        changes: [{ at: 1, deleted: "", inserted: "b" }],
        lastAppendedAt: 0,
      },
    ]);
    el.value = "a";
    editor._beginStream("insert_at_cursor");

    editor.redo();

    expect(el.value).toBe("a");
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(1);
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    editor._endStream();
  });
});

describe("bounds-check fallback (Req 21 desync-recovery)", () => {
  it("undo() with a desynchronized change.inserted leaves stacks unchanged and logs", () => {
    const el = installBuffer("hi");
    editor.initialize();
    // Change claims to have inserted "!" at position 2, but the
    // buffer is "hi" so position 2 has no content. Undo should
    // detect the mismatch, leave the stack alone, and log.
    const desyncedGroup = {
      source: "typing",
      beforeSelection: { start: 2, end: 2 },
      afterSelection: { start: 3, end: 3 },
      changes: [{ at: 2, deleted: "", inserted: "!" }],
      lastAppendedAt: 0,
    };
    editor._setUndoStackForTests([desyncedGroup]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    editor.undo();

    expect(el.value).toBe("hi");
    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0]).toBe(desyncedGroup);
    expect(redoStack).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("redo() with a desynchronized change.deleted leaves stacks unchanged and logs", () => {
    const el = installBuffer("hi");
    editor.initialize();
    // Change claims to delete "X" at position 0, but the buffer is
    // "hi" so position 0 starts with "h". Redo should detect the
    // mismatch.
    const desyncedGroup = {
      source: "typing",
      beforeSelection: { start: 0, end: 0 },
      afterSelection: { start: 1, end: 1 },
      changes: [{ at: 0, deleted: "X", inserted: "Y" }],
      lastAppendedAt: 0,
    };
    editor._setRedoStackForTests([desyncedGroup]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    editor.redo();

    expect(el.value).toBe("hi");
    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(redoStack).toHaveLength(1);
    expect(redoStack[0]).toBe(desyncedGroup);
    expect(undoStack).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("dispatches `editor:status` CustomEvent on document with the desync message", () => {
    const el = installBuffer("hi");
    editor.initialize();
    editor._setUndoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 0, end: 0 },
        afterSelection: { start: 1, end: 1 },
        changes: [{ at: 99, deleted: "", inserted: "!" }],
        lastAppendedAt: 0,
      },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    let captured = null;
    document.addEventListener("editor:status", (e) => {
      captured = e.detail;
    });

    editor.undo();

    expect(el.value).toBe("hi");
    expect(captured).toEqual({
      message: "undo/redo state desynchronized; please retry",
    });
  });
});

describe("`beforeinput` historyUndo/historyRedo interceptor", () => {
  it("routes `historyUndo` to editor.undo() with preventDefault", () => {
    const el = installBuffer("hi!");
    editor.initialize();
    editor._setUndoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 2, end: 2 },
        afterSelection: { start: 3, end: 3 },
        changes: [{ at: 2, deleted: "", inserted: "!" }],
        lastAppendedAt: 0,
      },
    ]);

    const event = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(el.value).toBe("hi");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(1);
  });

  it("routes `historyRedo` to editor.redo() with preventDefault", () => {
    const el = installBuffer("hi");
    editor.initialize();
    editor._setRedoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 2, end: 2 },
        afterSelection: { start: 3, end: 3 },
        changes: [{ at: 2, deleted: "", inserted: "!" }],
        lastAppendedAt: 0,
      },
    ]);

    const event = new InputEvent("beforeinput", {
      inputType: "historyRedo",
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(el.value).toBe("hi!");
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(0);
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(1);
  });

  it("preventDefaults `historyUndo` even while a stream is active (browser history must never run)", () => {
    const el = installBuffer("hi");
    editor.initialize();
    editor._setUndoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 0, end: 0 },
        afterSelection: { start: 1, end: 1 },
        changes: [{ at: 0, deleted: "", inserted: "h" }],
        lastAppendedAt: 0,
      },
    ]);
    editor._beginStream("insert_at_cursor");

    const event = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    // Stream-active: undo() is a no-op (Req 18.21).
    expect(el.value).toBe("hi");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(1);
    editor._endStream();
  });
});

describe("_completeStream stream-group commit (Req 18.7, 18.8, 18.9, 18.10)", () => {
  it("pushes the stream group onto undoStack when changes.length >= 1", () => {
    const el = installBuffer("");
    editor.initialize();
    editor._beginStream("insert_at_cursor");
    // Apply a couple of tokens via the public surface so the
    // appliers append change records onto streamAnchor.group.changes.
    editor.applyLLMResponse("insert_at_cursor", "He");
    editor.applyLLMResponse("insert_at_cursor", "llo");

    expect(el.value).toBe("Hello");
    // Position the caret at end of buffer to mirror what a real
    // stream complete would see.
    el.selectionStart = 5;
    el.selectionEnd = 5;
    expect(editor._stateForTests().streamActive).toBe(true);

    editor._completeStream();

    const { undoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0].source).toBe("stream");
    expect(undoStack[0].changes).toHaveLength(2);
    expect(undoStack[0].afterSelection).toEqual({ start: 5, end: 5 });
    expect(editor._stateForTests().streamActive).toBe(false);
    expect(editor._streamAnchorForTests()).toBeNull();
  });

  it("commits even on an error/cancel arm provided changes.length >= 1 (Req 18.9, 18.10)", () => {
    const el = installBuffer("");
    editor.initialize();
    editor._beginStream("insert_at_cursor");
    editor.applyLLMResponse("insert_at_cursor", "x");
    expect(el.value).toBe("x");

    // _completeStream is called whether the terminal arm was end-of
    // -stream, cancel, or any Req 14 error reason (Task 21 spec). As
    // long as changes.length >= 1, the group commits.
    el.selectionStart = 1;
    el.selectionEnd = 1;
    editor._completeStream();

    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(1);
    expect(editor._undoRedoStateForTests().undoStack[0].source).toBe("stream");
  });

  it("does NOT push when changes.length === 0 (Req 18.10 precondition)", () => {
    installBuffer("");
    editor.initialize();
    editor._beginStream("insert_at_cursor");
    // No tokens applied — changes is empty.
    expect(editor._streamAnchorForTests().group.changes).toHaveLength(0);

    editor._completeStream();

    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    expect(editor._stateForTests().streamActive).toBe(false);
    expect(editor._streamAnchorForTests()).toBeNull();
  });

  it("a single undo() after _completeStream restores the pre-stream buffer (Req 18.8)", () => {
    const el = installBuffer("pre-stream ");
    editor.initialize();
    el.selectionStart = 11;
    el.selectionEnd = 11;
    editor._beginStream("insert_at_cursor");
    editor.applyLLMResponse("insert_at_cursor", "tok1");
    editor.applyLLMResponse("insert_at_cursor", "tok2");
    el.selectionStart = el.value.length;
    el.selectionEnd = el.value.length;
    editor._completeStream();
    expect(el.value).toBe("pre-stream tok1tok2");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(1);

    editor.undo();

    expect(el.value).toBe("pre-stream ");
    expect(editor._undoRedoStateForTests().undoStack).toHaveLength(0);
    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(1);
  });

  it("clears redoStack on commit because the source is not Redo (Req 18.15)", () => {
    const el = installBuffer("");
    editor.initialize();
    editor._setRedoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 0, end: 0 },
        afterSelection: { start: 1, end: 1 },
        changes: [{ at: 0, deleted: "", inserted: "z" }],
        lastAppendedAt: 0,
      },
    ]);
    editor._beginStream("insert_at_cursor");
    editor.applyLLMResponse("insert_at_cursor", "x");
    el.selectionStart = 1;
    el.selectionEnd = 1;

    editor._completeStream();

    expect(editor._undoRedoStateForTests().redoStack).toHaveLength(0);
  });
});
