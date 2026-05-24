// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — editor.openFile / saveFile / saveFileAs / dirty-prompt
// unit tests for Task 25.
//
// Coverage:
//   - openFile() with a user-cancelled native picker leaves the
//     Buffer / currentPath / Status_Bar unchanged (Req 4.2).
//   - openFile() on a clean buffer routes through api.openFile and
//     replaces the buffer (Req 4.4).
//   - openFile() on a dirty buffer surfaces the Save/Discard/Cancel
//     prompt before any state change (Req 4.3):
//       - Cancel aborts.
//       - Discard proceeds without writing.
//       - Save invokes Save then proceeds; if save fails, abort.
//   - openFile() failure dispatches the error verbatim and leaves
//     state unchanged (Req 4.8, 4.9).
//   - saveFile() with currentPath set calls api.saveFile and clears
//     dirty (Req 5.4).
//   - saveFile() with no currentPath delegates to saveFileAs()
//     (Req 5.2).
//   - saveFile() failure dispatches the error verbatim and leaves
//     the Buffer dirty (Req 5.5).
//   - saveFileAs() with cancel returns false and leaves state
//     unchanged (Req 6.2).
//   - saveFileAs() success records the new path and clears dirty
//     (Req 6.4).
//   - saveFileAs() failure leaves currentPath unchanged and the
//     Buffer dirty (Req 6.6).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as editor from "../editor.js";

/** Build the minimal DOM the editor module reaches for. */
function installBuffer(initialValue = "") {
  document.body.innerHTML = `<textarea id="buffer"></textarea>`;
  const el = document.getElementById("buffer");
  el.value = initialValue;
  return el;
}

/**
 * Capture every `editor:status` CustomEvent dispatched on `document`.
 * Returns an array of detail.message strings in dispatch order plus
 * a teardown function.
 */
function captureStatusMessages() {
  const messages = [];
  const handler = (e) => {
    if (e && e.detail && typeof e.detail.message === "string") {
      messages.push(e.detail.message);
    }
  };
  document.addEventListener("editor:status", handler);
  return {
    messages,
    teardown: () => document.removeEventListener("editor:status", handler),
  };
}

/**
 * Install a stub Tauri IPC bridge so api.js's openFile/saveFile land
 * on a recorder. Returns the calls array and lets the test override
 * the open_file / save_file responses.
 */
function installTauri({ openImpl, saveImpl } = {}) {
  const calls = [];
  globalThis.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "open_file") {
          return typeof openImpl === "function"
            ? openImpl(args)
            : Promise.resolve("");
        }
        if (cmd === "save_file") {
          return typeof saveImpl === "function"
            ? saveImpl(args)
            : Promise.resolve(undefined);
        }
        return Promise.resolve();
      },
    },
  };
  return calls;
}

beforeEach(() => {
  document.body.innerHTML = "";
  delete globalThis.__TAURI__;
  // Reset any test-installed dialog overrides between cases.
  editor._setFileDialogsForTests(null);
});

afterEach(() => {
  delete globalThis.__TAURI__;
  editor._setFileDialogsForTests(null);
});

/* ------------------------------------------------------------------ */
/* openFile()                                                          */
/* ------------------------------------------------------------------ */

describe("editor.openFile — cancel leaves state unchanged (Req 4.2)", () => {
  it("returns without invoking api.openFile when the picker resolves to null", async () => {
    const el = installBuffer("seed");
    editor.initialize();
    const calls = installTauri();
    editor._setFileDialogsForTests({
      open: async () => null,
    });

    await editor.openFile();

    expect(el.value).toBe("seed");
    expect(editor._stateForTests().currentPath).toBeNull();
    expect(calls.filter((c) => c.cmd === "open_file")).toHaveLength(0);
  });

  it("returns without invoking api.openFile when the picker rejects", async () => {
    const el = installBuffer("seed");
    editor.initialize();
    const calls = installTauri();
    const cap = captureStatusMessages();
    editor._setFileDialogsForTests({
      open: async () => {
        throw "permission denied";
      },
    });

    await editor.openFile();

    expect(el.value).toBe("seed");
    expect(calls.filter((c) => c.cmd === "open_file")).toHaveLength(0);
    expect(cap.messages).toContain("permission denied");
    cap.teardown();
  });
});

describe("editor.openFile — clean buffer success path (Req 4.4)", () => {
  it("calls api.openFile with the picked path and replaces the buffer", async () => {
    const el = installBuffer("");
    editor.initialize();
    const calls = installTauri({
      openImpl: async ({ path }) => {
        expect(path).toBe("/tmp/picked.txt");
        return "loaded contents";
      },
    });
    editor._setFileDialogsForTests({
      open: async () => "/tmp/picked.txt",
    });

    await editor.openFile();

    expect(el.value).toBe("loaded contents");
    expect(editor._stateForTests().currentPath).toBe("/tmp/picked.txt");
    expect(editor.isDirty()).toBe(false);
    expect(calls.filter((c) => c.cmd === "open_file")).toHaveLength(1);
  });

  it("clears undo and redo stacks on success (Req 18.16)", async () => {
    installBuffer("");
    editor.initialize();
    editor._setUndoStackForTests([
      {
        source: "typing",
        beforeSelection: { start: 0, end: 0 },
        afterSelection: { start: 0, end: 0 },
        changes: [],
        lastAppendedAt: 0,
      },
    ]);
    editor._setRedoStackForTests([
      {
        source: "paste",
        beforeSelection: { start: 0, end: 0 },
        afterSelection: { start: 0, end: 0 },
        changes: [],
        lastAppendedAt: 0,
      },
    ]);
    installTauri({ openImpl: async () => "fresh" });
    editor._setFileDialogsForTests({ open: async () => "/tmp/x.txt" });

    await editor.openFile();

    const { undoStack, redoStack } = editor._undoRedoStateForTests();
    expect(undoStack).toHaveLength(0);
    expect(redoStack).toHaveLength(0);
  });
});

describe("editor.openFile — explicit path bypasses the dialog", () => {
  it("does not consult the dialog plugin when a path is supplied", async () => {
    const el = installBuffer("");
    editor.initialize();
    let dialogCalls = 0;
    editor._setFileDialogsForTests({
      open: async () => {
        dialogCalls += 1;
        return "/tmp/should-not-be-used.txt";
      },
    });
    installTauri({ openImpl: async () => "via path" });

    await editor.openFile("/tmp/explicit.txt");

    expect(el.value).toBe("via path");
    expect(editor._stateForTests().currentPath).toBe("/tmp/explicit.txt");
    expect(dialogCalls).toBe(0);
  });
});

describe("editor.openFile — dirty-buffer prompt (Req 4.3)", () => {
  function makeDirty(el) {
    el.value = "edited";
    expect(editor.isDirty()).toBe(true);
  }

  it("Cancel aborts the open without invoking api.openFile or the dialog", async () => {
    const el = installBuffer("seed");
    editor.initialize();
    makeDirty(el);
    const calls = installTauri();
    let dialogCalls = 0;
    editor._setFileDialogsForTests({
      open: async () => {
        dialogCalls += 1;
        return "/tmp/x.txt";
      },
      prompt: async () => "cancel",
    });

    await editor.openFile();

    expect(el.value).toBe("edited");
    expect(editor.isDirty()).toBe(true);
    expect(calls.filter((c) => c.cmd === "open_file")).toHaveLength(0);
    expect(dialogCalls).toBe(0);
  });

  it("Discard proceeds without writing (api.saveFile is not called)", async () => {
    const el = installBuffer("seed");
    editor.initialize();
    makeDirty(el);
    const calls = installTauri({ openImpl: async () => "fresh" });
    editor._setFileDialogsForTests({
      open: async () => "/tmp/x.txt",
      prompt: async () => "discard",
    });

    await editor.openFile();

    expect(el.value).toBe("fresh");
    expect(calls.filter((c) => c.cmd === "save_file")).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "open_file")).toHaveLength(1);
    expect(editor._stateForTests().currentPath).toBe("/tmp/x.txt");
  });

  it("Save invokes saveFile then proceeds when save succeeds", async () => {
    const el = installBuffer("seed");
    editor.initialize();
    // Pre-set currentPath so saveFile() does not delegate to Save As.
    editor._replaceBufferOnOpen("seed", "/tmp/old.txt");
    el.value = "edited";
    expect(editor.isDirty()).toBe(true);
    const calls = installTauri({ openImpl: async () => "fresh" });
    editor._setFileDialogsForTests({
      open: async () => "/tmp/new.txt",
      prompt: async () => "save",
    });

    await editor.openFile();

    expect(calls.filter((c) => c.cmd === "save_file")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "open_file")).toHaveLength(1);
    expect(el.value).toBe("fresh");
    expect(editor._stateForTests().currentPath).toBe("/tmp/new.txt");
  });

  it("Save then abort: when saveFile fails, the open is cancelled", async () => {
    const el = installBuffer("seed");
    editor.initialize();
    editor._replaceBufferOnOpen("seed", "/tmp/old.txt");
    el.value = "edited";
    const calls = installTauri({
      openImpl: async () => "fresh",
      saveImpl: async () => {
        throw "could not save file: denied";
      },
    });
    const cap = captureStatusMessages();
    editor._setFileDialogsForTests({
      open: async () => "/tmp/new.txt",
      prompt: async () => "save",
    });

    await editor.openFile();

    expect(calls.filter((c) => c.cmd === "save_file")).toHaveLength(1);
    expect(calls.filter((c) => c.cmd === "open_file")).toHaveLength(0);
    expect(el.value).toBe("edited");
    expect(editor._stateForTests().currentPath).toBe("/tmp/old.txt");
    expect(cap.messages).toContain("could not save file: denied");
    cap.teardown();
  });
});

describe("editor.openFile — failure path (Req 4.8, 4.9)", () => {
  it("dispatches the error verbatim and leaves state unchanged", async () => {
    const el = installBuffer("seed");
    editor.initialize();
    installTauri({
      openImpl: async () => {
        throw "file is not valid UTF-8";
      },
    });
    const cap = captureStatusMessages();
    editor._setFileDialogsForTests({
      open: async () => "/tmp/binary.bin",
    });

    await editor.openFile();

    expect(el.value).toBe("seed");
    expect(editor._stateForTests().currentPath).toBeNull();
    expect(cap.messages).toContain("file is not valid UTF-8");
    cap.teardown();
  });
});

/* ------------------------------------------------------------------ */
/* saveFile()                                                          */
/* ------------------------------------------------------------------ */

describe("editor.saveFile — with currentPath (Req 5.4)", () => {
  it("calls api.saveFile with currentPath and the live buffer", async () => {
    const el = installBuffer("");
    editor.initialize();
    editor._replaceBufferOnOpen("loaded", "/tmp/a.txt");
    el.value = "edited";
    const calls = installTauri();
    const cap = captureStatusMessages();

    const ok = await editor.saveFile();

    expect(ok).toBe(true);
    expect(calls.filter((c) => c.cmd === "save_file")).toHaveLength(1);
    expect(calls[0].args).toEqual({
      path: "/tmp/a.txt",
      contents: "edited",
    });
    // Dirty-flag clears (Req 5.4) and an empty status clears any
    // prior error.
    expect(editor.isDirty()).toBe(false);
    expect(cap.messages.at(-1)).toBe("");
    cap.teardown();
  });
});

describe("editor.saveFile — no currentPath delegates to saveFileAs (Req 5.2)", () => {
  it("calls saveFileAs() and forwards its result", async () => {
    const el = installBuffer("");
    editor.initialize();
    el.value = "draft";
    const calls = installTauri();
    let saveAsDialogCalls = 0;
    editor._setFileDialogsForTests({
      save: async () => {
        saveAsDialogCalls += 1;
        return "/tmp/new.txt";
      },
    });

    const ok = await editor.saveFile();

    expect(ok).toBe(true);
    expect(saveAsDialogCalls).toBe(1);
    expect(calls.filter((c) => c.cmd === "save_file")).toHaveLength(1);
    expect(editor._stateForTests().currentPath).toBe("/tmp/new.txt");
  });

  it("returns false when the user cancels the Save As dialog", async () => {
    installBuffer("");
    editor.initialize();
    installTauri();
    editor._setFileDialogsForTests({
      save: async () => null,
    });

    const ok = await editor.saveFile();

    expect(ok).toBe(false);
    expect(editor._stateForTests().currentPath).toBeNull();
  });
});

describe("editor.saveFile — failure (Req 5.5)", () => {
  it("dispatches the error verbatim and leaves the Buffer dirty", async () => {
    const el = installBuffer("");
    editor.initialize();
    editor._replaceBufferOnOpen("loaded", "/tmp/a.txt");
    el.value = "edited";
    installTauri({
      saveImpl: async () => {
        throw "could not save file: read-only";
      },
    });
    const cap = captureStatusMessages();

    const ok = await editor.saveFile();

    expect(ok).toBe(false);
    expect(editor.isDirty()).toBe(true);
    expect(editor._stateForTests().currentPath).toBe("/tmp/a.txt");
    expect(cap.messages).toContain("could not save file: read-only");
    cap.teardown();
  });
});

/* ------------------------------------------------------------------ */
/* saveFileAs()                                                        */
/* ------------------------------------------------------------------ */

describe("editor.saveFileAs — cancel leaves state unchanged (Req 6.2)", () => {
  it("returns false when the user cancels the save dialog", async () => {
    const el = installBuffer("");
    editor.initialize();
    editor._replaceBufferOnOpen("loaded", "/tmp/a.txt");
    el.value = "edited";
    const calls = installTauri();
    editor._setFileDialogsForTests({
      save: async () => null,
    });

    const ok = await editor.saveFileAs();

    expect(ok).toBe(false);
    expect(calls.filter((c) => c.cmd === "save_file")).toHaveLength(0);
    expect(editor._stateForTests().currentPath).toBe("/tmp/a.txt");
    expect(editor.isDirty()).toBe(true);
    void el;
  });
});

describe("editor.saveFileAs — success (Req 6.4)", () => {
  it("records the new path and clears dirty", async () => {
    const el = installBuffer("");
    editor.initialize();
    editor._replaceBufferOnOpen("loaded", "/tmp/old.md");
    el.value = "edited";
    const calls = installTauri();
    editor._setFileDialogsForTests({
      save: async (suggestedExt) => {
        // Suggested extension matches the current path's `.md`
        // extension (Req 6.1).
        expect(suggestedExt).toBe(".md");
        return "/tmp/new.md";
      },
    });

    const ok = await editor.saveFileAs();

    expect(ok).toBe(true);
    expect(calls.filter((c) => c.cmd === "save_file")).toHaveLength(1);
    expect(calls[0].args).toEqual({
      path: "/tmp/new.md",
      contents: "edited",
    });
    expect(editor._stateForTests().currentPath).toBe("/tmp/new.md");
    expect(editor.isDirty()).toBe(false);
  });

  it("suggests .txt when no extension is associated with the buffer", async () => {
    const el = installBuffer("");
    editor.initialize();
    el.value = "draft";
    let observedExt = null;
    installTauri();
    editor._setFileDialogsForTests({
      save: async (suggestedExt) => {
        observedExt = suggestedExt;
        return "/tmp/new.txt";
      },
    });

    await editor.saveFileAs();

    expect(observedExt).toBe(".txt");
  });
});

describe("editor.saveFileAs — failure (Req 6.6)", () => {
  it("leaves currentPath unchanged and the Buffer dirty", async () => {
    const el = installBuffer("");
    editor.initialize();
    editor._replaceBufferOnOpen("loaded", "/tmp/old.txt");
    el.value = "edited";
    installTauri({
      saveImpl: async () => {
        throw "could not save file: out of space";
      },
    });
    const cap = captureStatusMessages();
    editor._setFileDialogsForTests({
      save: async () => "/tmp/new.txt",
    });

    const ok = await editor.saveFileAs();

    expect(ok).toBe(false);
    expect(editor._stateForTests().currentPath).toBe("/tmp/old.txt");
    expect(editor.isDirty()).toBe(true);
    expect(cap.messages).toContain("could not save file: out of space");
    cap.teardown();
  });
});

/* ------------------------------------------------------------------ */
/* currentFilePath() public accessor                                   */
/* ------------------------------------------------------------------ */

describe("editor.currentFilePath", () => {
  it("returns null for an Untitled buffer (Req 9.2)", () => {
    installBuffer("");
    editor.initialize();

    expect(editor.currentFilePath()).toBeNull();
  });

  it("returns the path after a successful open (Req 9.1)", async () => {
    installBuffer("");
    editor.initialize();
    installTauri({ openImpl: async () => "x" });
    editor._setFileDialogsForTests({ open: async () => "/tmp/file.txt" });

    await editor.openFile();

    expect(editor.currentFilePath()).toBe("/tmp/file.txt");
  });
});
