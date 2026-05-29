// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Vitest config for live LM Studio smoke tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/__tests__/smoke/**/*.test.js"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Smoke tests live under src/__tests__/smoke/ and are excluded from the
    // default vitest.config.js include set. Use: npm run test:smoke
    setupFiles: ["src/__tests__/setup/default_tools_setup.js"],
  },
});
