// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Layout dimensions from designs/LLIMEdit-design.pen (Tool Editor Pane).

/** Document Editor column width in the design artboard. */
export const DESIGN_DOCUMENT_EDITOR_WIDTH_PX = 568;

/** Tool Editor Pane (`toolEdPane`) fixed height. */
export const DESIGN_TOOL_EDITOR_PANE_HEIGHT_PX = 396;

/** Tool File Bar (`toolFileBar`) height. */
export const DESIGN_TOOL_FILE_BAR_HEIGHT_PX = 86;

/** Tool Console (`whsjf`) height. */
export const DESIGN_TOOL_CONSOLE_HEIGHT_PX = 76;

/** Minimum tool pane height when dragging the horizontal split (file bar + console + small editors). */
export const MIN_TOOL_EDITOR_PANE_HEIGHT_PX =
  DESIGN_TOOL_FILE_BAR_HEIGHT_PX + DESIGN_TOOL_CONSOLE_HEIGHT_PX + 120;
