// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Vitest configuration for the LLIMEdit frontend.
// Selects the jsdom environment (per design.md) and scopes tests to
// src/__tests__/**/*.test.js so the property-based tests under that
// folder are picked up on a clean checkout.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/__tests__/**/*.test.js"],
    exclude: ["src/__tests__/smoke/**"],
    setupFiles: ["src/__tests__/setup/default_tools_setup.js"],
  },
});
