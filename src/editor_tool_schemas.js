// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Editor tool schemas — loaded from default.lmtools at runtime.

import { getDefaultToolSchemas } from "./default_tools.js";

/** @returns {Array<{ type: string, function: object }>} */
export function editorToolDefinitions() {
  return getDefaultToolSchemas();
}
