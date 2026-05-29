// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach } from "vitest";
import { _internal as defaultToolsInternal } from "../../default_tools.js";

const defaultPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../default.lmtools"
);

beforeEach(async () => {
  defaultToolsInternal.resetForTests();
  defaultToolsInternal.setTestOverrideRaw(readFileSync(defaultPath, "utf8"));
  const { ensureDefaultToolsLoaded } = await import("../../default_tools.js");
  await ensureDefaultToolsLoaded();
});
