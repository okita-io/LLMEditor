// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Undo/redo and Tab → spaces for tool-editor textareas (and other
// secondary editors). Mirrors the document buffer's edit-history model
// in a self-contained attach/detach module.

const UNDO_REDO_CAPACITY = 200;

const CURSOR_JUMP_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
function isPrintableTypedKey(e) {
  if (!e || typeof e.key !== "string") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "Enter") return true;
  return e.key.length === 1;
}

/**
 * @param {HTMLTextAreaElement} el
 * @returns {{ start: number, end: number }}
 */
function captureSelection(el) {
  const start = typeof el.selectionStart === "number" ? el.selectionStart : 0;
  const end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
  return { start, end };
}

/**
 * @param {HTMLTextAreaElement} el
 * @param {{ start: number, end: number }} selection
 * @returns {void}
 */
function restoreSelection(el, selection) {
  el.selectionStart = selection.start;
  el.selectionEnd = selection.end;
}

/**
 * @param {string} value
 * @param {Array<{ at: number, deleted: string, inserted: string }>} changes
 * @returns {string | null}
 */
function applyChangesForward(value, changes) {
  let current = value;
  for (const change of changes) {
    const { at, deleted, inserted } = change;
    if (!Number.isInteger(at) || at < 0 || at > current.length) return null;
    const actual = current.slice(at, at + deleted.length);
    if (actual !== deleted) return null;
    current = current.slice(0, at) + inserted + current.slice(at + deleted.length);
  }
  return current;
}

/**
 * @param {string} value
 * @param {Array<{ at: number, deleted: string, inserted: string }>} changes
 * @returns {string | null}
 */
function applyChangesReverse(value, changes) {
  let current = value;
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i];
    const { at, inserted, deleted } = change;
    if (!Number.isInteger(at) || at < 0 || at > current.length) return null;
    const actual = current.slice(at, at + inserted.length);
    if (actual !== inserted) return null;
    current = current.slice(0, at) + deleted + current.slice(at + inserted.length);
  }
  return current;
}

/**
 * @param {Array<object>} stack
 * @param {object} group
 */
function pushOnto(stack, group) {
  if (stack.length >= UNDO_REDO_CAPACITY) {
    stack.shift();
  }
  stack.push(group);
}

/**
 * Attach undo/redo and Tab → spaces handling to a textarea.
 *
 * @param {HTMLTextAreaElement} el
 * @param {{
 *   getTabSpaces?: () => number,
 *   isActive?: () => boolean,
 * }} [options]
 * @returns {{
 *   undo: () => void,
 *   redo: () => void,
 *   clear: () => void,
 *   destroy: () => void,
 * }}
 */
export function attachTextareaEditHistory(el, options = {}) {
  const getTabSpaces =
    typeof options.getTabSpaces === "function" ? options.getTabSpaces : () => 4;
  const isActive = typeof options.isActive === "function" ? options.isActive : () => true;

  /** @type {Array<object>} */
  const undoStack = [];
  /** @type {Array<object>} */
  const redoStack = [];
  let cursorJumped = false;
  let lastRecordedSelection = captureSelection(el);
  /** @type {{ value: string, selection: { start: number, end: number } } | null} */
  let pendingTypedSnapshot = null;
  /** @type {KeyboardEvent | { key?: string } | null} */
  let pendingTypedKey = null;

  /**
   * @param {object} group
   * @param {{ fromRedo?: boolean }} [opts]
   */
  function pushUndo(group, { fromRedo = false } = {}) {
    pushOnto(undoStack, group);
    if (!fromRedo) {
      redoStack.length = 0;
    }
  }

  /**
   * @param {KeyboardEvent | { key?: string }} keyEvent
   * @param {{
   *   at: number,
   *   deleted: string,
   *   inserted: string,
   *   beforeSelection: { start: number, end: number },
   *   afterSelection: { start: number, end: number },
   * }} change
   */
  function recordTypedKeystroke(keyEvent, change) {
    if (!isActive()) return;
    const isEnter = keyEvent && keyEvent.key === "Enter";
    const top = undoStack[undoStack.length - 1];
    const now = Date.now();
    const canAppend =
      !isEnter &&
      !cursorJumped &&
      top !== undefined &&
      top.source === "typing" &&
      now - top.lastAppendedAt <= 1000;

    if (canAppend) {
      top.changes.push({
        at: change.at,
        deleted: change.deleted,
        inserted: change.inserted,
      });
      top.afterSelection = { ...change.afterSelection };
      top.lastAppendedAt = now;
    } else {
      pushUndo({
        source: "typing",
        beforeSelection: { ...change.beforeSelection },
        afterSelection: { ...change.afterSelection },
        changes: [
          {
            at: change.at,
            deleted: change.deleted,
            inserted: change.inserted,
          },
        ],
        lastAppendedAt: now,
      });
    }

    cursorJumped = false;
    lastRecordedSelection = { ...change.afterSelection };
  }

  function insertTabSpaces() {
    const count = getTabSpaces() === 2 ? 2 : 4;
    const spaces = " ".repeat(count);
    const beforeSelection = captureSelection(el);
    const start = beforeSelection.start;
    const end = beforeSelection.end;
    const value = el.value;
    const deleted = value.slice(start, end);
    const next = value.slice(0, start) + spaces + value.slice(end);
    el.value = next;
    const newCaret = start + spaces.length;
    el.selectionStart = newCaret;
    el.selectionEnd = newCaret;

    pushUndo({
      source: "tab",
      beforeSelection: { ...beforeSelection },
      afterSelection: { start: newCaret, end: newCaret },
      changes: [{ at: start, deleted, inserted: spaces }],
      lastAppendedAt: Date.now(),
    });

    cursorJumped = true;
    lastRecordedSelection = { start: newCaret, end: newCaret };
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function undo() {
    const group = undoStack.pop();
    if (group === undefined) return;
    const next = applyChangesReverse(el.value, group.changes);
    if (next === null) {
      undoStack.push(group);
      return;
    }
    el.value = next;
    restoreSelection(el, group.beforeSelection);
    pushOnto(redoStack, group);
    cursorJumped = true;
    lastRecordedSelection = { ...group.beforeSelection };
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function redo() {
    const group = redoStack.pop();
    if (group === undefined) return;
    const next = applyChangesForward(el.value, group.changes);
    if (next === null) {
      redoStack.push(group);
      return;
    }
    el.value = next;
    restoreSelection(el, group.afterSelection);
    pushUndo(group, { fromRedo: true });
    cursorJumped = true;
    lastRecordedSelection = { ...group.afterSelection };
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    cursorJumped = false;
    lastRecordedSelection = captureSelection(el);
  }

  const onKeydown = (e) => {
    if (
      e.key === "Tab" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.target === el &&
      isActive()
    ) {
      e.preventDefault();
      insertTabSpaces();
      return;
    }

    if (CURSOR_JUMP_KEYS.has(e.key)) {
      cursorJumped = true;
      return;
    }

    if (!isActive()) return;

    if (isPrintableTypedKey(e)) {
      pendingTypedKey = e;
    }
  };

  const onBeforeInput = (e) => {
    if (e.inputType === "historyUndo") {
      if (typeof e.preventDefault === "function") e.preventDefault();
      undo();
      return;
    }
    if (e.inputType === "historyRedo") {
      if (typeof e.preventDefault === "function") e.preventDefault();
      redo();
      return;
    }
    if (!isActive()) return;
    if (
      e.inputType === "insertText" ||
      e.inputType === "insertLineBreak" ||
      e.inputType === "insertParagraph"
    ) {
      pendingTypedSnapshot = {
        value: el.value,
        selection: captureSelection(el),
      };
    }
  };

  const onInput = (e) => {
    if (!isActive()) return;
    if (!pendingTypedSnapshot) return;
    if (
      e.inputType !== "insertText" &&
      e.inputType !== "insertLineBreak" &&
      e.inputType !== "insertParagraph"
    ) {
      pendingTypedSnapshot = null;
      pendingTypedKey = null;
      return;
    }
    const before = pendingTypedSnapshot;
    pendingTypedSnapshot = null;
    const keyEvent = pendingTypedKey || { key: e.data || "" };
    pendingTypedKey = null;

    const { value: prevValue, selection: prevSel } = before;
    const nextValue = el.value;
    const at = prevSel.start;
    const deleted = prevValue.slice(prevSel.start, prevSel.end);
    const afterSel = captureSelection(el);
    const insertedLen = afterSel.start - at;
    const inserted = insertedLen >= 0 ? nextValue.slice(at, at + insertedLen) : "";

    recordTypedKeystroke(keyEvent, {
      at,
      deleted,
      inserted,
      beforeSelection: prevSel,
      afterSelection: afterSel,
    });
  };

  const onPaste = (event) => {
    if (!isActive()) return;
    const cd = event.clipboardData || globalThis.clipboardData;
    if (!cd) return;
    const text = typeof cd.getData === "function" ? cd.getData("text/plain") : "";
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof text !== "string" || text.length === 0) return;

    const beforeSelection = captureSelection(el);
    const start = beforeSelection.start;
    const end = beforeSelection.end;
    const value = el.value;
    const deleted = value.slice(start, end);
    const next = value.slice(0, start) + text + value.slice(end);
    el.value = next;
    const newCaret = start + text.length;
    const afterSelection = { start: newCaret, end: newCaret };
    el.selectionStart = newCaret;
    el.selectionEnd = newCaret;

    pushUndo({
      source: "paste",
      beforeSelection: { ...beforeSelection },
      afterSelection: { ...afterSelection },
      changes: [{ at: start, deleted, inserted: text }],
      lastAppendedAt: Date.now(),
    });

    cursorJumped = true;
    lastRecordedSelection = { ...afterSelection };
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const onMousedown = () => {
    cursorJumped = true;
  };
  const onClick = () => {
    cursorJumped = true;
  };
  const onSelect = () => {
    const sel = captureSelection(el);
    if (sel.start !== lastRecordedSelection.start || sel.end !== lastRecordedSelection.end) {
      cursorJumped = true;
      lastRecordedSelection = { ...sel };
    }
  };

  el.addEventListener("keydown", onKeydown);
  el.addEventListener("beforeinput", onBeforeInput);
  el.addEventListener("input", onInput);
  el.addEventListener("mousedown", onMousedown);
  el.addEventListener("click", onClick);
  el.addEventListener("select", onSelect);
  el.addEventListener("paste", onPaste);

  el.style.tabSize = String(getTabSpaces() === 2 ? 2 : 4);

  function destroy() {
    el.removeEventListener("keydown", onKeydown);
    el.removeEventListener("beforeinput", onBeforeInput);
    el.removeEventListener("input", onInput);
    el.removeEventListener("mousedown", onMousedown);
    el.removeEventListener("click", onClick);
    el.removeEventListener("select", onSelect);
    el.removeEventListener("paste", onPaste);
  }

  return { undo, redo, clear, destroy };
}
