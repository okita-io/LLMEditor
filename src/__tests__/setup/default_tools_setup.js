// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { beforeEach } from "vitest";
import { _internal as toolEditorInternal } from "../../tool_editor.js";
import { loadDefaultToolsFixture } from "./default_lmtools_fixture.js";

beforeEach(() => {
  toolEditorInternal.resetForTests();
  loadDefaultToolsFixture();
});
