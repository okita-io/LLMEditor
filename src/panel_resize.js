// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Draggable dividers between chat, inference, and document panels.

const MIN_CHAT_W = 260;
const MIN_INFERENCE_W = 300;
const MIN_DOCUMENT_W = 200;

/**
 * @param {HTMLElement} divider
 * @param {(delta: number) => void} onDrag
 */
function wireDividerDrag(divider, onDrag) {
  let dragging = false;
  let lastCoord = 0;

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    lastCoord = e.clientX;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const delta = e.clientX - lastCoord;
    lastCoord = e.clientX;
    if (delta !== 0) onDrag(delta);
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.dispatchEvent(new Event("resize"));
  });
}

/**
 * Pin a panel to an explicit pixel width so flex stops fighting drag sizing.
 *
 * @param {HTMLElement | null} el
 * @param {number} widthPx
 */
function setPanelWidth(el, widthPx) {
  if (!el) return;
  el.style.flex = "none";
  el.style.width = `${widthPx}px`;
  el.style.minWidth = "";
  el.style.maxWidth = "";
}

/**
 * @returns {void}
 */
export function initPanelResize() {
  const chatPanel = document.getElementById("chat-panel");
  const inferencePanel = document.getElementById("inference-panel");
  const documentEditor = document.getElementById("document-editor");
  const inferenceDivider = document.getElementById("inference-divider");
  const documentDivider = document.getElementById("split-divider");

  if (inferenceDivider && chatPanel && inferencePanel) {
    wireDividerDrag(inferenceDivider, (delta) => {
      const chatW = chatPanel.offsetWidth;
      const infW = inferencePanel.offsetWidth;
      const newChat = Math.max(MIN_CHAT_W, chatW + delta);
      const newInf = Math.max(MIN_INFERENCE_W, infW - delta);
      setPanelWidth(chatPanel, newChat);
      setPanelWidth(inferencePanel, newInf);
    });
  }

  if (documentDivider && inferencePanel && documentEditor) {
    documentEditor.style.flex = "1 1 auto";
    documentEditor.style.minWidth = `${MIN_DOCUMENT_W}px`;

    wireDividerDrag(documentDivider, (delta) => {
      const infW = inferencePanel.offsetWidth;
      const newInf = Math.max(MIN_INFERENCE_W, infW + delta);
      setPanelWidth(inferencePanel, newInf);
    });
  }
}
