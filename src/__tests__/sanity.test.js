// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Sanity test: confirms the Vitest + jsdom toolchain is wired up
// correctly so `npm test` passes on a clean checkout.

import { describe, it, expect } from "vitest";

describe("toolchain sanity", () => {
  it("performs basic arithmetic", () => {
    expect(1 + 1).toBe(2);
  });
});
