// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _internal as toolEditorInternal,
  parseToolFileContents,
} from "../../tool_editor.js";

export const defaultLmtoolsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../default.lmtools"
);

/**
 * Load default.lmtools into the tool editor state (tests only).
 * @returns {void}
 */
export function loadDefaultToolsFixture() {
  const raw = readFileSync(defaultLmtoolsPath, "utf8");
  const { implementation, schema } = parseToolFileContents(raw);
  toolEditorInternal.setLoadedToolsForTests({ implementation, schema });
}
