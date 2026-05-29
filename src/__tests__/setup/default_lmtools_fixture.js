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
 *
 * Parses the real default.lmtools and feeds BOTH halves into the tool editor's
 * test setup via setLoadedToolsForTests:
 *  - implementation: the full self-contained Tool_Implementation source
 *    (per-tool functions + `tools` registry + `run` dispatcher). This is
 *    registered as the implementation override so getAgentToolFunctions can
 *    compile it and executeAgentTool can run the extracted tools by name.
 *  - schema: the seven function tool definitions (get_document, goto_line,
 *    insert_text, replace_line, replace_span, delete_lines, delete_span).
 * @returns {void}
 */
export function loadDefaultToolsFixture() {
  const raw = readFileSync(defaultLmtoolsPath, "utf8");
  const { implementation, schema } = parseToolFileContents(raw);
  toolEditorInternal.setLoadedToolsForTests({ implementation, schema });
}
