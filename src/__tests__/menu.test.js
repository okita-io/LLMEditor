// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — menu.js unit tests.
//
// Covers the Task 22 surface:
//   - `buildMenuBar()` renders the four documented menus with their
//     items in the right order (Req 2.1-2.5).
//   - `setAiMenuEnabled(false)` flips `data-disabled` on the AI
//     wrapper and on every AI item (Req 1.3, 2.6); `(true)` clears
//     it (Req 1.6).
//   - `Cmd/Ctrl+O` fires `editor.openFile` (Req 3.1).
//   - `Cmd/Ctrl+S` fires `editor.saveFile`, `Cmd/Ctrl+Shift+S` fires
//     `editor.saveFileAs` (Req 3.2, 3.3).
//   - `Cmd/Ctrl+L` fires `editor.sendToLLM` (Req 3.4).
//   - Escape with the modal open closes the modal (Req 11.8).
//   - Escape with a stream active calls `api.cancelStream` (Req 13.7).
//   - Escape with neither is a no-op (Req 3.8).
//   - Document-modifying shortcuts are no-ops while the modal is open
//     or a stream is active, but still preventDefault (Req 3.6, 3.7).
//   - AI menu disabled state gates Send-to-Model and Settings clicks.
//
// The module relies on `navigator.platform.toLowerCase().includes("mac")`
// at import time. We stub the platform before each test via
// `Object.defineProperty(navigator, "platform", ...)` and use Vitest's
// `vi.resetModules()` + dynamic `await import("../menu.js")` so each
// test sees a fresh module evaluation with the right modifier branch.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as editor from "../editor.js";
import * as api from "../api.js";
import * as editTarget from "../edit_target.js";
import * as settingsModal from "../settings_modal.js";
import * as menu from "../menu.js";

/** Mock the editor / api / settings_modal modules so we can assert
 * which entry points the menu wires. The implementations are
 * non-throwing stubs so dispatchAction's promise wrappers resolve. */
vi.mock("../editor.js", () => {
  return {
    newFile: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => undefined),
    saveFileAs: vi.fn(async () => undefined),
    sendToLLM: vi.fn(async () => undefined),
    undo: vi.fn(),
    redo: vi.fn(),
    isStreamActive: vi.fn(() => false),
  };
});

vi.mock("../api.js", () => {
  return {
    cancelStream: vi.fn(async () => undefined),
  };
});

vi.mock("../edit_target.js", () => ({
  undoActiveEditTarget: vi.fn(),
  redoActiveEditTarget: vi.fn(),
  registerEditTarget: vi.fn(),
  setLastEditTarget: vi.fn(),
  getLastEditTarget: vi.fn(() => "document"),
  resetEditTargetsForTests: vi.fn(),
}));

vi.mock("../settings_modal.js", () => {
  return {
    isModalOpen: vi.fn(() => false),
    open: vi.fn(),
    close: vi.fn(),
  };
});

/**
 * Install the menu-bar shell HTML in the document body. Mirrors the
 * structure of `index.html` so `buildMenuBar()` has the nav anchor
 * to render into.
 */
function installShell() {
  document.body.innerHTML = `
    <nav id="menu-bar"></nav>
    <textarea id="buffer"></textarea>
    <footer id="status-bar"></footer>
  `;
}

/**
 * Force `navigator.platform` to a value containing "Mac" (or not).
 * Menu.js re-evaluates the platform per call, so the next event will
 * see the latest stub.
 *
 * @param {boolean} mac
 */
function stubPlatform(mac) {
  Object.defineProperty(globalThis.navigator, "platform", {
    value: mac ? "MacIntel" : "Win32",
    configurable: true,
  });
}

beforeEach(() => {
  installShell();
  // Reset all mock call counts and default implementations.
  for (const fn of Object.values(editor)) {
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  }
  editor.isStreamActive.mockImplementation(() => false);
  editor.openFile.mockImplementation(async () => undefined);
  editor.newFile.mockImplementation(async () => undefined);
  editor.saveFile.mockImplementation(async () => undefined);
  editor.saveFileAs.mockImplementation(async () => undefined);
  editor.sendToLLM.mockImplementation(async () => undefined);

  for (const fn of Object.values(api)) {
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  }
  api.cancelStream.mockImplementation(async () => undefined);

  for (const fn of Object.values(settingsModal)) {
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  }
  settingsModal.isModalOpen.mockImplementation(() => false);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/* ---------------- buildMenuBar ---------------------------------- */

describe("buildMenuBar — DOM structure (Req 2.1-2.5)", () => {
  it("renders four top-level menus in File / Edit / AI / Help order", async () => {
    stubPlatform(false);
    
    menu.buildMenuBar();
    const menus = document.querySelectorAll("#menu-bar .menu");
    expect(menus).toHaveLength(4);
    const labels = Array.from(menus).map(
      (m) => m.querySelector(".menu-label").textContent
    );
    expect(labels).toEqual(["File", "Edit", "AI", "Help"]);
  });

  it("renders File menu items in New/Open/Save/Save As/Quit order", async () => {
    stubPlatform(false);
    
    menu.buildMenuBar();
    const file = document.querySelector('[data-menu="file"]');
    const items = file.querySelectorAll(".menu-item-label");
    expect(Array.from(items).map((i) => i.textContent)).toEqual([
      "New...",
      "Open",
      "Save",
      "Save As",
      "Quit",
    ]);
  });

  it("renders Edit menu items in Undo/Redo/Cut/Copy/Paste order", async () => {
    stubPlatform(false);
    
    menu.buildMenuBar();
    const edit = document.querySelector('[data-menu="edit"]');
    const items = edit.querySelectorAll(".menu-item-label");
    expect(Array.from(items).map((i) => i.textContent)).toEqual([
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
    ]);
  });

  it("renders AI menu items in Send to Model / Settings order", async () => {
    stubPlatform(false);
    
    menu.buildMenuBar();
    const ai = document.querySelector('[data-menu="ai"]');
    expect(ai.dataset.aiMenu).toBe("true");
    const items = ai.querySelectorAll(".menu-item-label");
    expect(Array.from(items).map((i) => i.textContent)).toEqual([
      "Send to Model",
      "Settings",
    ]);
    const aiItems = ai.querySelectorAll('[data-ai-item="true"]');
    expect(aiItems).toHaveLength(2);
  });

  it("renders Help menu with About", async () => {
    stubPlatform(false);
    
    menu.buildMenuBar();
    const help = document.querySelector('[data-menu="help"]');
    const items = help.querySelectorAll(".menu-item-label");
    expect(Array.from(items).map((i) => i.textContent)).toEqual(["About"]);
  });

  it("is idempotent: rebuilding does not duplicate items", async () => {
    stubPlatform(false);
    
    menu.buildMenuBar();
    menu.buildMenuBar();
    expect(document.querySelectorAll("#menu-bar .menu")).toHaveLength(4);
  });
});

/* ---------------- setAiMenuEnabled ------------------------------ */

describe("setAiMenuEnabled (Req 1.3, 2.6, 1.6)", () => {
  it("setting false marks the AI wrapper and items as data-disabled", async () => {
    stubPlatform(false);
    
    menu.buildMenuBar();

    menu.setAiMenuEnabled(false);

    const ai = document.querySelector('[data-ai-menu="true"]');
    expect(ai.getAttribute("data-disabled")).toBe("true");
    const items = document.querySelectorAll('[data-ai-item="true"]');
    for (const el of items) {
      expect(el.getAttribute("data-disabled")).toBe("true");
    }
  });

  it("setting true clears the data-disabled attribute", async () => {
    stubPlatform(false);
    
    menu.buildMenuBar();
    menu.setAiMenuEnabled(false);

    menu.setAiMenuEnabled(true);

    const ai = document.querySelector('[data-ai-menu="true"]');
    expect(ai.hasAttribute("data-disabled")).toBe(false);
    const items = document.querySelectorAll('[data-ai-item="true"]');
    for (const el of items) {
      expect(el.hasAttribute("data-disabled")).toBe(false);
    }
  });
});

/* ---------------- Keyboard shortcuts ---------------------------- */

/**
 * Dispatch a keydown via the document so the menu's capture-phase
 * listener sees it.
 *
 * @param {string} key
 * @param {{ shift?: boolean, ctrl?: boolean, meta?: boolean }} mods
 */
function pressKey(key, mods = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey: mods.shift === true,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe("Keyboard shortcuts on Windows (Ctrl modifier)", () => {
  beforeEach(() => stubPlatform(false));

  it("Ctrl+N fires editor.newFile and preventDefaults", async () => {
    
    menu.buildMenuBar();

    const e = pressKey("n", { ctrl: true });

    expect(e.defaultPrevented).toBe(true);
    expect(editor.newFile).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+O fires editor.openFile and preventDefaults (Req 3.1)", async () => {
    
    menu.buildMenuBar();

    const e = pressKey("o", { ctrl: true });

    expect(e.defaultPrevented).toBe(true);
    expect(editor.openFile).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+S fires editor.saveFile (Req 3.2)", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("s", { ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.saveFile).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Shift+S fires editor.saveFileAs (Req 3.3)", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("S", { ctrl: true, shift: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.saveFileAs).toHaveBeenCalledTimes(1);
    expect(editor.saveFile).not.toHaveBeenCalled();
  });

  it("Ctrl+L fires editor.sendToLLM (Req 3.4)", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("l", { ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.sendToLLM).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Z calls editTarget.undoActiveEditTarget, Ctrl+Shift+Z and Ctrl+Y call redo", async () => {
    
    menu.buildMenuBar();
    pressKey("z", { ctrl: true });
    expect(editTarget.undoActiveEditTarget).toHaveBeenCalledTimes(1);

    pressKey("Z", { ctrl: true, shift: true });
    expect(editTarget.redoActiveEditTarget).toHaveBeenCalledTimes(1);

    pressKey("y", { ctrl: true });
    expect(editTarget.redoActiveEditTarget).toHaveBeenCalledTimes(2);
  });

  it("plain O / S / L without modifier do nothing", async () => {
    
    menu.buildMenuBar();
    pressKey("o");
    pressKey("s");
    pressKey("l");
    expect(editor.openFile).not.toHaveBeenCalled();
    expect(editor.saveFile).not.toHaveBeenCalled();
    expect(editor.sendToLLM).not.toHaveBeenCalled();
  });
});

describe("Keyboard shortcuts on macOS (Cmd / metaKey modifier)", () => {
  beforeEach(() => stubPlatform(true));

  it("Cmd+N fires editor.newFile", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("n", { meta: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.newFile).toHaveBeenCalledTimes(1);
  });

  it("Cmd+O fires editor.openFile (Req 3.1)", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("o", { meta: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.openFile).toHaveBeenCalledTimes(1);
  });

  it("Cmd+Shift+S fires editor.saveFileAs and not Save", async () => {
    
    menu.buildMenuBar();
    pressKey("S", { meta: true, shift: true });
    expect(editor.saveFileAs).toHaveBeenCalledTimes(1);
    expect(editor.saveFile).not.toHaveBeenCalled();
  });

  it("Ctrl+O on macOS does NOT fire (modifier-branch isolation)", async () => {
    
    menu.buildMenuBar();
    pressKey("o", { ctrl: true });
    expect(editor.openFile).not.toHaveBeenCalled();
  });

  it("Ctrl+Y on macOS does NOT fire Redo (Windows-only binding)", async () => {
    
    menu.buildMenuBar();
    pressKey("y", { ctrl: true });
    pressKey("y", { meta: true });
    expect(editTarget.redoActiveEditTarget).not.toHaveBeenCalled();
  });
});

/* ---------------- Escape handling ------------------------------- */

describe("Escape key", () => {
  beforeEach(() => stubPlatform(false));

  it("closes the modal when one is open (Req 11.8)", async () => {
    settingsModal.isModalOpen.mockReturnValue(true);
    
    menu.buildMenuBar();

    const e = pressKey("Escape");

    expect(e.defaultPrevented).toBe(true);
    expect(settingsModal.close).toHaveBeenCalledTimes(1);
    expect(api.cancelStream).not.toHaveBeenCalled();
  });

  it("cancels the stream when one is active and modal is closed (Req 13.7)", async () => {
    settingsModal.isModalOpen.mockReturnValue(false);
    editor.isStreamActive.mockReturnValue(true);
    
    menu.buildMenuBar();

    const e = pressKey("Escape");

    expect(e.defaultPrevented).toBe(true);
    expect(api.cancelStream).toHaveBeenCalledTimes(1);
    expect(settingsModal.close).not.toHaveBeenCalled();
  });

  it("is a no-op when neither modal is open nor stream is active (Req 3.8)", async () => {
    settingsModal.isModalOpen.mockReturnValue(false);
    editor.isStreamActive.mockReturnValue(false);
    
    menu.buildMenuBar();

    const e = pressKey("Escape");

    expect(e.defaultPrevented).toBe(false);
    expect(api.cancelStream).not.toHaveBeenCalled();
    expect(settingsModal.close).not.toHaveBeenCalled();
  });

  it("modal-close takes precedence over stream-cancel when both apply", async () => {
    settingsModal.isModalOpen.mockReturnValue(true);
    editor.isStreamActive.mockReturnValue(true);
    
    menu.buildMenuBar();

    pressKey("Escape");

    expect(settingsModal.close).toHaveBeenCalledTimes(1);
    expect(api.cancelStream).not.toHaveBeenCalled();
  });
});

/* ---------------- Gating predicates ----------------------------- */

describe("Gating: modal open (Req 3.6)", () => {
  beforeEach(() => {
    stubPlatform(false);
    settingsModal.isModalOpen.mockReturnValue(true);
  });

  it("Ctrl+O is a no-op but still preventDefaults", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("o", { ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.openFile).not.toHaveBeenCalled();
  });

  it("Ctrl+S is a no-op but still preventDefaults", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("s", { ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.saveFile).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+S is a no-op but still preventDefaults", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("S", { ctrl: true, shift: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.saveFileAs).not.toHaveBeenCalled();
  });

  it("Ctrl+L is a no-op but still preventDefaults", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("l", { ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.sendToLLM).not.toHaveBeenCalled();
  });
});

describe("Gating: stream active (Req 3.7)", () => {
  beforeEach(() => {
    stubPlatform(false);
    settingsModal.isModalOpen.mockReturnValue(false);
    editor.isStreamActive.mockReturnValue(true);
  });

  it("Ctrl+O is a no-op but still preventDefaults", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("o", { ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.openFile).not.toHaveBeenCalled();
  });

  it("Ctrl+S is a no-op but still preventDefaults", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("s", { ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.saveFile).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+S is a no-op but still preventDefaults", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("S", { ctrl: true, shift: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.saveFileAs).not.toHaveBeenCalled();
  });

  it("Ctrl+L is a no-op but still preventDefaults", async () => {
    
    menu.buildMenuBar();
    const e = pressKey("l", { ctrl: true });
    expect(e.defaultPrevented).toBe(true);
    expect(editor.sendToLLM).not.toHaveBeenCalled();
  });
});

/* ---------------- AI menu disabled state -------------------------*/

describe("AI menu disabled state gates clicks (Req 1.3, 2.6)", () => {
  beforeEach(() => stubPlatform(false));

  it("clicking 'Send to Model' while AI is disabled is a no-op", async () => {
    
    menu.buildMenuBar();
    menu.setAiMenuEnabled(false);

    const item = document.querySelector(
      '[data-ai-item="true"][data-action="send_to_model"]'
    );
    expect(item).not.toBeNull();
    item.click();

    expect(editor.sendToLLM).not.toHaveBeenCalled();
  });

  it("clicking 'Send to Model' after enabling fires editor.sendToLLM", async () => {
    
    menu.buildMenuBar();
    menu.setAiMenuEnabled(true);

    const item = document.querySelector(
      '[data-ai-item="true"][data-action="send_to_model"]'
    );
    item.click();

    expect(editor.sendToLLM).toHaveBeenCalledTimes(1);
  });

  it("clicking 'Settings' while AI is disabled is a no-op", async () => {
    
    menu.buildMenuBar();
    menu.setAiMenuEnabled(false);

    const item = document.querySelector(
      '[data-ai-item="true"][data-action="settings"]'
    );
    item.click();

    expect(settingsModal.open).not.toHaveBeenCalled();
  });

  it("clicking 'Settings' when enabled opens the modal", async () => {
    
    menu.buildMenuBar();
    menu.setAiMenuEnabled(true);

    const item = document.querySelector(
      '[data-ai-item="true"][data-action="settings"]'
    );
    item.click();

    expect(settingsModal.open).toHaveBeenCalledTimes(1);
  });
});

/* ---------------- Menu item clicks ------------------------------ */

describe("Menu-item click dispatch", () => {
  beforeEach(() => stubPlatform(false));

  it("clicking File → Open fires editor.openFile", async () => {
    
    menu.buildMenuBar();
    document.querySelector('[data-action="open"]').click();
    expect(editor.openFile).toHaveBeenCalledTimes(1);
  });

  it("clicking File → New... fires editor.newFile", async () => {
    
    menu.buildMenuBar();
    document.querySelector('[data-action="new"]').click();
    expect(editor.newFile).toHaveBeenCalledTimes(1);
  });

  it("clicking Edit → Undo fires editTarget.undoActiveEditTarget", async () => {
    
    menu.buildMenuBar();
    document.querySelector('[data-action="undo"]').click();
    expect(editTarget.undoActiveEditTarget).toHaveBeenCalledTimes(1);
  });

  it("clicking Edit → Redo fires editTarget.redoActiveEditTarget", async () => {
    
    menu.buildMenuBar();
    document.querySelector('[data-action="redo"]').click();
    expect(editTarget.redoActiveEditTarget).toHaveBeenCalledTimes(1);
  });
});

/* ---------------- Menu dropdown close --------------------------- */

describe("Menu dropdown close after native dialogs", () => {
  beforeEach(() => stubPlatform(false));

  it("closeAllMenus removes open state and blurs menu focus", () => {
    menu.buildMenuBar();
    const fileMenu = document.querySelector('[data-menu="file"]');
    fileMenu.classList.add("open");
    const openItem = document.querySelector('[data-action="open"]');
    openItem.focus();

    menu._internal.closeAllMenus();

    expect(fileMenu.classList.contains("open")).toBe(false);
    expect(fileMenu.contains(document.activeElement)).toBe(false);
  });

  it("re-closes File menu after Open completes when focus returns to the menu item", async () => {
    menu.buildMenuBar();
    const fileMenu = document.querySelector('[data-menu="file"]');
    const openItem = document.querySelector('[data-action="open"]');

    /** @type {(() => void) | undefined} */
    let resolveOpen;
    editor.openFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        })
    );

    openItem.click();
    expect(fileMenu.classList.contains("open")).toBe(false);

    openItem.focus();
    expect(fileMenu.contains(document.activeElement)).toBe(true);

    resolveOpen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fileMenu.contains(document.activeElement)).toBe(false);
  });
});
