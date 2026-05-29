// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Editor tool schemas — from the loaded tool file in the tool editor.

import { getAgentToolSchemas } from "./tool_editor.js";

/** @returns {Array<{ type: string, function: object }>} */
export function editorToolDefinitions() {
  return getAgentToolSchemas();
}
