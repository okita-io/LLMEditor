// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — menu.js
//
// Owns the in-window menu bar HTML, click bindings, and keyboard
// shortcuts (Req 2, Req 3). The single source of truth for which
// menus exist, which items they contain, and what each item does is
// the `MENUS` descriptor below; `buildMenuBar()` renders that
// descriptor into the `<nav id="menu-bar">` shell from `index.html`,
// and the keydown handler in `_onGlobalKeydown` maps the documented
// shortcuts to the same `dispatchAction` entry point that menu clicks
// run.
//
// Action gating (Req 3.6, 3.7, 11.8, 12.6, 13.7, 18.21):
//
//   - Document-modifying shortcuts (Open / Save / Save As / Send to
//     Model) are no-ops while either the Settings_Modal is open or a
//     stream is active. The keydown handler still calls
//     `event.preventDefault()` for those bindings so the host browser
//     does not run its built-in "save page" or "open file" action.
//   - Edit menu Undo / Redo are no-ops at the editor.js boundary
//     while a stream is active (Req 18.21); menu.js still calls
//     `preventDefault()` on the matching keydown so the textarea's
//     built-in history does not run.
//   - Escape: close the modal if open (Req 11.8); else cancel the
//     stream if one is active (Req 13.7); else no-op (Req 3.5, 3.8).
//
// Modifier detection (Req 3.1-3.4): Cmd on macOS, Ctrl on Windows.
// The detection runs once at module load via
// `navigator.platform.toLowerCase().includes('mac')`. Tests can drive
// either branch by re-importing the module after stubbing
// `navigator.platform`.
//
// AI menu disabled state (Req 1.3, 2.6, 1.6): `setAiMenuEnabled(false)`
// adds `data-disabled="true"` to every AI-tagged item and to the AI
// menu wrapper. `dispatchAction` checks the live `data-disabled`
// attribute before firing, so a click that races the
// `loadSettings()` resolution still cannot run an AI action.

import * as editor from "./editor.js";
import * as api from "./api.js";
import * as editTarget from "./edit_target.js";
import * as settingsModal from "./settings_modal.js";

const MENU_BAR_ID = "menu-bar";

/**
 * Whether the host is macOS — Cmd modifier vs Ctrl (Req 3.1-3.4).
 *
 * Re-evaluated at call time rather than memoized at module load so
 * tests can stub `navigator.platform` per-case without re-importing
 * the module. Production cost is one string check per shortcut event,
 * which is negligible.
 *
 * @returns {boolean}
 */
function isMac() {
  try {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.platform === "string" &&
      navigator.platform.toLowerCase().includes("mac")
    );
  } catch {
    return false;
  }
}

/**
 * Action-id catalogue. Strings are stable: every menu item carries
 * its action id in `data-action`, every shortcut binding fires the
 * same id, and `dispatchAction` is the one place that maps id to
 * handler.
 */
const ACTIONS = {
  NEW: "new",
  OPEN: "open",
  SAVE: "save",
  SAVE_AS: "save_as",
  QUIT: "quit",
  UNDO: "undo",
  REDO: "redo",
  CUT: "cut",
  COPY: "copy",
  PASTE: "paste",
  SEND_TO_MODEL: "send_to_model",
  SETTINGS: "settings",
  ABOUT: "about",
};

/**
 * Document-modifying shortcuts whose keydown is `preventDefault`'d
 * even when the action is gated off (Req 3.6, 3.7). The browser's
 * default Cmd/Ctrl+S "save page" must not run while the modal is
 * open or a stream is active; the user pressed the shortcut intending
 * a no-op, not a page save. Send-to-Model is included for parity
 * (Cmd/Ctrl+L is "focus address bar" in most browsers; Tauri's
 * WebView still routes it to us, but we suppress it for safety).
 */
const DOCUMENT_MODIFYING = new Set([
  ACTIONS.NEW,
  ACTIONS.OPEN,
  ACTIONS.SAVE,
  ACTIONS.SAVE_AS,
  ACTIONS.SEND_TO_MODEL,
]);

/** Actions that the AI-menu disable flag gates (Req 1.3, 2.6, 1.6). */
const AI_ACTIONS = new Set([ACTIONS.SEND_TO_MODEL, ACTIONS.SETTINGS]);

/**
 * Top-to-bottom menu definitions, mirroring Req 2.1-2.5. Each item
 * carries its action id and an optional shortcut label; the shortcut
 * label is rendered next to the item so users can discover the
 * binding without reading the docs.
 */
const MENUS = [
  {
    label: "File",
    items: [
      { label: "New...", action: ACTIONS.NEW, shortcut: "N" },
      { label: "Open", action: ACTIONS.OPEN, shortcut: "O" },
      { label: "Save", action: ACTIONS.SAVE, shortcut: "S" },
      { label: "Save As", action: ACTIONS.SAVE_AS, shortcut: "Shift+S" },
      { label: "Quit", action: ACTIONS.QUIT },
    ],
  },
  {
    label: "Edit",
    items: [
      { label: "Undo", action: ACTIONS.UNDO, shortcut: "Z" },
      { label: "Redo", action: ACTIONS.REDO, shortcut: "Shift+Z" },
      { label: "Cut", action: ACTIONS.CUT, shortcut: "X" },
      { label: "Copy", action: ACTIONS.COPY, shortcut: "C" },
      { label: "Paste", action: ACTIONS.PASTE, shortcut: "V" },
    ],
  },
  {
    label: "AI",
    ai: true,
    items: [
      { label: "Send to Model", action: ACTIONS.SEND_TO_MODEL, shortcut: "L" },
      { label: "Settings", action: ACTIONS.SETTINGS },
    ],
  },
  {
    label: "Help",
    items: [{ label: "About", action: ACTIONS.ABOUT }],
  },
];

/* ------------------------------------------------------------------ */
/* Public surface.                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the menu bar markup into `<nav id="menu-bar">` and bind the
 * global keyboard shortcuts. Idempotent: re-calling tears down the
 * previous keydown listener before installing a fresh one so test
 * setups can re-build into a clean DOM without leaking handlers.
 *
 * @returns {void}
 */
export function buildMenuBar() {
  if (typeof document === "undefined") return;

  const nav = document.getElementById(MENU_BAR_ID);
  if (nav) {
    nav.replaceChildren();
    for (const menu of MENUS) {
      nav.appendChild(buildMenuElement(menu));
    }
  }

  installSettingsButton();
  installKeydownListener();
}

/**
 * Toggle the disabled state of every AI menu item and the AI menu
 * wrapper. Disabled items render dimmed via CSS (the `data-disabled`
 * attribute hook) and `dispatchAction` rejects them at click time,
 * regardless of any race between the click and the warm-up.
 *
 * @param {boolean} enabled
 * @returns {void}
 */
export function setAiMenuEnabled(enabled) {
  if (typeof document === "undefined") return;
  const nav = document.getElementById(MENU_BAR_ID);
  if (!nav) return;
  const items = nav.querySelectorAll('[data-ai-item="true"]');
  for (const el of items) {
    if (enabled) {
      el.removeAttribute("data-disabled");
    } else {
      el.dataset.disabled = "true";
    }
  }
  const aiMenu = nav.querySelector('[data-ai-menu="true"]');
  if (aiMenu) {
    if (enabled) {
      aiMenu.removeAttribute("data-disabled");
    } else {
      aiMenu.dataset.disabled = "true";
    }
  }
}

/* ------------------------------------------------------------------ */
/* DOM construction.                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build a single top-level `<div class="menu">` element with its
 * label and item list, including click handlers and shortcut hints.
 *
 * @param {{label: string, items: Array<object>, ai?: boolean}} menu
 * @returns {HTMLElement}
 */
function buildMenuElement(menu) {
  const wrapper = document.createElement("div");
  wrapper.className = "menu";
  wrapper.dataset.menu = menu.label.toLowerCase();
  if (menu.ai) wrapper.dataset.aiMenu = "true";

  const label = document.createElement("span");
  label.className = "menu-label";
  label.textContent = menu.label;
  label.tabIndex = 0;
  label.addEventListener("click", () => {
    const open = wrapper.classList.contains("open");
    closeAllMenus();
    if (!open) wrapper.classList.add("open");
  });
  wrapper.appendChild(label);

  const itemList = document.createElement("ul");
  itemList.className = "menu-items";
  for (const item of menu.items) {
    itemList.appendChild(buildMenuItem(item, menu.ai === true));
  }
  wrapper.appendChild(itemList);

  return wrapper;
}

/**
 * Build a single `<li class="menu-item">` element with action wiring.
 *
 * @param {{label: string, action: string, shortcut?: string}} item
 * @param {boolean} isAi
 * @returns {HTMLElement}
 */
function buildMenuItem(item, isAi) {
  const li = document.createElement("li");
  li.className = "menu-item";
  li.dataset.action = item.action;
  if (isAi) li.dataset.aiItem = "true";
  li.tabIndex = 0;

  const text = document.createElement("span");
  text.className = "menu-item-label";
  text.textContent = item.label;
  li.appendChild(text);

  if (item.shortcut) {
    const hint = document.createElement("span");
    hint.className = "menu-item-shortcut";
    hint.textContent = formatShortcutHint(item.shortcut);
    li.appendChild(hint);
  }

  li.addEventListener("click", (e) => {
    e.preventDefault();
    closeAllMenus();
    dispatchAction(item.action, { source: "click" });
  });

  return li;
}

/**
 * Close every open menu dropdown and release menu focus so
 * `:focus-within` CSS does not keep the panel visible after native
 * dialogs (Open / Save / Save As) return focus to the menu item.
 *
 * @returns {void}
 */
function closeAllMenus() {
  if (typeof document === "undefined") return;
  const menuBar = document.getElementById(MENU_BAR_ID);
  const menus = document.querySelectorAll("#menu-bar .menu.open");
  for (const menu of menus) menu.classList.remove("open");

  const active = document.activeElement;
  if (
    menuBar &&
    active &&
    typeof active.blur === "function" &&
    menuBar.contains(active)
  ) {
    active.blur();
  }
}

/**
 * Run an async menu action that may open a native dialog, keeping
 * menus closed when focus returns to the WebView.
 *
 * @param {() => Promise<unknown>} run
 * @returns {void}
 */
function runAsyncMenuAction(run) {
  closeAllMenus();
  Promise.resolve(run()).catch((err) => {
    console.error("menu action failed:", err);
  }).finally(() => {
    closeAllMenus();
  });
}

/**
 * Wire the top-right settings gear to open the Settings modal.
 *
 * @returns {void}
 */
function installSettingsButton() {
  if (typeof document === "undefined") return;
  const button = document.getElementById("settings-button");
  if (!button || button.dataset.bound === "true") return;
  button.dataset.bound = "true";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    closeAllMenus();
    openSettingsModal();
  });
}

/**
 * Render a shortcut label like `Cmd+O` (macOS) or `Ctrl+Shift+S`.
 *
 * @param {string} shortcut Suffix string (e.g. `"O"`, `"Shift+S"`).
 * @returns {string}
 */
function formatShortcutHint(shortcut) {
  const modifier = isMac() ? "Cmd" : "Ctrl";
  return `${modifier}+${shortcut}`;
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcut wiring.                                           */
/* ------------------------------------------------------------------ */

/** Reference to the bound keydown handler so it can be detached. */
let keydownHandler = null;

/**
 * Install the document-level keydown listener that maps the
 * documented shortcuts (Req 3.1-3.5) to action ids. Detaches any
 * previously installed handler first so `buildMenuBar()` is
 * idempotent.
 *
 * The previous handler reference is stashed on `document` itself
 * (`document.__llimeditMenuKeydown`) in addition to the module-scoped
 * `keydownHandler`. Vitest's `vi.resetModules()` re-evaluates this
 * file, which gives the fresh module a `keydownHandler` of `null` and
 * loses the reference to the previous evaluation's handler. Stashing
 * the handler on the document lets the fresh module find and detach
 * the stale listener so tests do not accumulate handlers across
 * imports.
 */
function installKeydownListener() {
  if (typeof document === "undefined") return;
  const stashed = document.__llimeditMenuKeydown;
  if (stashed) {
    document.removeEventListener("keydown", stashed, true);
  }
  if (keydownHandler) {
    document.removeEventListener("keydown", keydownHandler, true);
  }
  keydownHandler = _onGlobalKeydown;
  document.__llimeditMenuKeydown = keydownHandler;
  // Capture phase so the textarea's own keydown listener cannot
  // swallow the event before we see it.
  document.addEventListener("keydown", keydownHandler, true);
}

/**
 * Map a `KeyboardEvent` to one of the documented shortcut action ids,
 * or `null` if no binding matches. Pure function; no DOM access.
 *
 * @param {KeyboardEvent} e
 * @returns {string | null}
 */
function matchShortcut(e) {
  if (e.key === "Escape") return "escape";

  const mac = isMac();
  const modifier = mac ? e.metaKey : e.ctrlKey;
  if (!modifier) return null;
  // The opposite-platform modifier must not be held — Cmd+Ctrl+S on
  // macOS is not Save.
  if (mac && e.ctrlKey) return null;
  if (!mac && e.metaKey) return null;

  const key = (e.key || "").toLowerCase();
  const shift = e.shiftKey === true;

  // Document-modifying shortcuts (Req 3.1-3.4).
  if (key === "n" && !shift) return ACTIONS.NEW;
  if (key === "o" && !shift) return ACTIONS.OPEN;
  if (key === "s" && !shift) return ACTIONS.SAVE;
  if (key === "s" && shift) return ACTIONS.SAVE_AS;
  if (key === "l" && !shift) return ACTIONS.SEND_TO_MODEL;

  // Edit menu Undo / Redo. macOS: Cmd+Z and Cmd+Shift+Z. Windows:
  // Ctrl+Z, Ctrl+Shift+Z, and Ctrl+Y for Redo.
  if (key === "z" && !shift) return ACTIONS.UNDO;
  if (key === "z" && shift) return ACTIONS.REDO;
  if (!mac && key === "y" && !shift) return ACTIONS.REDO;

  return null;
}

/**
 * Document-level keydown handler. Pure dispatcher: shortcut →
 * action id → `dispatchAction`. Escape is handled inline because it
 * has its own gating ladder (modal first, then stream cancel, then
 * no-op).
 *
 * @param {KeyboardEvent} e
 */
function _onGlobalKeydown(e) {
  const action = matchShortcut(e);
  if (action === null) return;

  if (action === "escape") {
    handleEscape(e);
    return;
  }

  // Document-modifying shortcuts always preventDefault, even when
  // the action is gated off (Req 3.6, 3.7) — the user must not see
  // the browser's built-in save-page dialog.
  if (DOCUMENT_MODIFYING.has(action)) {
    e.preventDefault();
  }

  // Undo/Redo: preventDefault so the textarea's built-in history
  // never runs in parallel with our stack (design.md "menu.js"
  // table). The `beforeinput` interceptor in editor.js is the
  // safety net; preventDefault here keeps the redundant browser
  // history from drifting on every keystroke.
  if (action === ACTIONS.UNDO || action === ACTIONS.REDO) {
    e.preventDefault();
  }

  // Gating ladder. We have already preventDefault'd the bindings
  // that need it; now decide whether to fire the action.
  if (settingsModal.isModalOpen()) {
    // Req 3.6: while modal open, document-modifying shortcuts are
    // no-ops. Edit-menu shortcuts also pass through to the editor
    // (so an undo while the modal is open simply runs against the
    // buffer), matching the user expectation of focus rules.
    if (DOCUMENT_MODIFYING.has(action) || AI_ACTIONS.has(action)) {
      return;
    }
  }
  if (editor.isStreamActive()) {
    // Req 3.7 + Req 18.21 + Req 12.6: while a stream is active,
    // document-modifying shortcuts and the AI shortcuts are
    // no-ops. Undo/Redo are also no-ops at the editor.js boundary,
    // but reaching the editor still emits `input` so we fire and
    // let editor.js return early.
    if (DOCUMENT_MODIFYING.has(action) || AI_ACTIONS.has(action)) {
      return;
    }
  }

  dispatchAction(action, { source: "shortcut" });
}

/**
 * Handle the Escape key (Req 3.5, 3.8, 11.8, 13.7).
 *
 * @param {KeyboardEvent} e
 */
function handleEscape(e) {
  if (settingsModal.isModalOpen()) {
    e.preventDefault();
    settingsModal.close();
    return;
  }
  if (editor.isLlmRequestActive()) {
    e.preventDefault();
    editor.stopActiveRequest();
    return;
  }
  // Req 3.8: no stream, no modal — no-op.
}

/* ------------------------------------------------------------------ */
/* Action dispatch.                                                    */
/* ------------------------------------------------------------------ */

/**
 * Single entry point for menu clicks and keyboard shortcuts. Re-runs
 * the gating predicates (a click on a click-while-disabled AI item
 * should still be a no-op even if the keydown path missed it) and
 * then dispatches to the editor or local handler.
 *
 * @param {string} action
 * @param {{ source: "click" | "shortcut" }} [opts]
 * @returns {void}
 */
function dispatchAction(action /*, opts */) {
  // AI menu disabled-state guard (Req 1.3, 2.6, 1.6). The data
  // attribute is the live source of truth toggled by
  // setAiMenuEnabled.
  if (AI_ACTIONS.has(action) && isAiActionDisabled()) {
    return;
  }

  // Modal gating for menu clicks of document-modifying actions.
  if (settingsModal.isModalOpen() && DOCUMENT_MODIFYING.has(action)) {
    return;
  }
  // Stream-active gating for document-modifying actions and AI
  // actions (Req 3.7, 12.6).
  if (
    editor.isStreamActive() &&
    (DOCUMENT_MODIFYING.has(action) || AI_ACTIONS.has(action))
  ) {
    return;
  }

  switch (action) {
    case ACTIONS.NEW:
      runAsyncMenuAction(() => editor.newFile());
      return;
    case ACTIONS.OPEN:
      runAsyncMenuAction(() => editor.openFile());
      return;
    case ACTIONS.SAVE:
      runAsyncMenuAction(() => editor.saveFile());
      return;
    case ACTIONS.SAVE_AS:
      runAsyncMenuAction(() => editor.saveFileAs());
      return;
    case ACTIONS.QUIT:
      requestQuit();
      return;
    case ACTIONS.UNDO:
      editTarget.undoActiveEditTarget();
      return;
    case ACTIONS.REDO:
      editTarget.redoActiveEditTarget();
      return;
    case ACTIONS.CUT:
      execClipboard("cut");
      return;
    case ACTIONS.COPY:
      execClipboard("copy");
      return;
    case ACTIONS.PASTE:
      execClipboard("paste");
      return;
    case ACTIONS.SEND_TO_MODEL:
      Promise.resolve(editor.sendToLLM()).catch((err) =>
        console.error("sendToLLM failed:", err)
      );
      return;
    case ACTIONS.SETTINGS:
      // settings_modal.js's `open()` is the canonical entry; we
      // import it lazily via a dynamic import so a stub
      // implementation in tests can still be exercised through
      // dispatchAction without circular re-evaluation.
      openSettingsModal();
      return;
    case ACTIONS.ABOUT:
      showAboutDialog();
      return;
    default:
      // Unknown action: no-op rather than throw so a future menu
      // item with an unbound id does not crash the keydown path.
      return;
  }
}

/**
 * Read the live `data-disabled` attribute on the AI menu wrapper to
 * decide whether AI actions are gated off. Matches the toggle done
 * by `setAiMenuEnabled` so a click that races the warm-up cannot
 * fire an AI action before settings are ready.
 *
 * @returns {boolean}
 */
function isAiActionDisabled() {
  if (typeof document === "undefined") return false;
  const nav = document.getElementById(MENU_BAR_ID);
  if (!nav) return false;
  const aiMenu = nav.querySelector('[data-ai-menu="true"]');
  if (!aiMenu) return false;
  return aiMenu.getAttribute("data-disabled") === "true";
}

/**
 * Cut / Copy / Paste from the menu bar. The user's keyboard
 * Ctrl/Cmd+X/C/V hits the textarea natively, so this path is only
 * exercised on a menu click. We focus the textarea first so the
 * clipboard command operates on the right element, then delegate to
 * `document.execCommand`. `execCommand` is deprecated but is the
 * only synchronous, no-permission-prompt clipboard path that works
 * inside Tauri's WebView for v0.1.
 *
 * @param {"cut"|"copy"|"paste"} command
 */
function execClipboard(command) {
  if (typeof document === "undefined") return;
  const buffer = document.getElementById("buffer");
  if (buffer && typeof buffer.focus === "function") {
    buffer.focus();
  }
  if (typeof document.execCommand === "function") {
    try {
      document.execCommand(command);
    } catch (err) {
      console.error(`execCommand(${command}) failed:`, err);
    }
  }
}

/**
 * Open the Settings_Modal (Req 11.1).
 */
function openSettingsModal() {
  if (typeof settingsModal.open === "function") {
    settingsModal.open();
  }
}

/**
 * Quit the application (Req 2.2). For v0.1 we close the host window
 * — the unsaved-changes prompt (Req 7) is owned by Task 25; this
 * path is the simplest "request the window to close" call that
 * works in Tauri's WebView and in jsdom (where it is a no-op).
 */
function requestQuit() {
  try {
    if (typeof window !== "undefined" && typeof window.close === "function") {
      window.close();
    }
  } catch (err) {
    console.error("quit failed:", err);
  }
}

/**
 * Show the About dialog (Req 2.8). v0.1 renders a `window.alert` with
 * the app name, current version, and MIT notice; a richer modal lands
 * with Task 25.
 */
function showAboutDialog() {
  const message = "LLIMEdit v0.1.0\nMIT License";
  try {
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(message);
    }
  } catch (err) {
    console.error("about dialog failed:", err);
  }
}

/* ------------------------------------------------------------------ */
/* Test hooks.                                                         */
/* ------------------------------------------------------------------ */

/**
 * Test-only hook: expose internal bindings so menu unit tests can
 * exercise the gating ladder without re-implementing it. Marked with
 * the `_` prefix so callers see at a glance that they are not part of
 * the public API.
 */
export const _internal = {
  isMac,
  ACTIONS,
  matchShortcut,
  dispatchAction,
  closeAllMenus,
};
