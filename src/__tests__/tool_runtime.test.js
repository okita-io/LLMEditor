// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Unit tests for the Tool_Editor accessors and Tool_Runtime error handling
// in src/tool_editor.js (task 3.5).
//
// These tests run without mounting the Tool_Editor DOM. With no editor
// elements mounted, readImplementationSource() falls back to the
// testImplementationOverride set via _internal.setLoadedToolsForTests, so the
// runtime and accessors operate on the implementation/schema we supply here.

import { beforeEach, describe, expect, it } from "vitest";
import {
  _internal,
  executeAgentTool,
  getAgentToolFunctions,
  getAgentToolSchemas,
} from "../tool_editor.js";

const VALID_TOOL = {
  type: "function",
  function: {
    name: "greet",
    description: "Say hello",
    parameters: { type: "object", properties: {} },
  },
};

describe("tool_runtime accessors and error handling", () => {
  beforeEach(() => {
    _internal.resetForTests();
  });

  describe("executeAgentTool — no implementation (Req 10.1)", () => {
    it("returns a no-implementation failure for an empty implementation", async () => {
      _internal.setLoadedToolsForTests({ implementation: "", schema: [] });

      const result = await executeAgentTool("get_document", {}, { text: "hi" });

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.error).toContain("no implementation");
    });

    it("returns a no-implementation failure for a whitespace-only implementation", async () => {
      _internal.setLoadedToolsForTests({ implementation: "   \n\t ", schema: [] });

      const result = await executeAgentTool("get_document", {}, { text: "hi" });

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.error).toContain("no implementation");
    });
  });

  describe("executeAgentTool — execution error (Req 10.2 / 10.4)", () => {
    it("returns a tool-execution-error result when the implementation throws", async () => {
      _internal.setLoadedToolsForTests({
        implementation: `
          function explode(args, ctx) { throw new Error("boom"); }
          const tools = { explode };
          function run(args, ctx) { return tools[ctx.toolName](args, ctx); }
        `,
        schema: [],
      });

      const result = await executeAgentTool("explode", {}, { text: "hi" });

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.error.startsWith("Tool execution error:")).toBe(true);
      expect(result.error).toContain("boom");
    });

    it("reports execution errors thrown via the run dispatcher fallback", async () => {
      _internal.setLoadedToolsForTests({
        implementation: `function run(args, ctx) { throw new Error("kaboom"); }`,
        schema: [],
      });

      const result = await executeAgentTool("anything", {}, { text: "hi" });

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.error.startsWith("Tool execution error:")).toBe(true);
    });
  });

  describe("executeAgentTool — no available implementation (Req 3.5)", () => {
    it("returns a no-available-implementation failure when neither the name nor run is defined", async () => {
      _internal.setLoadedToolsForTests({
        implementation: `
          function foo(args, ctx) { return { ok: true, changed: false }; }
          const tools = { foo };
        `,
        schema: [],
      });

      const result = await executeAgentTool("bar", {}, { text: "hi" });

      expect(result.ok).toBe(false);
      expect(result.changed).toBe(false);
      expect(result.error).toContain("no available implementation");
    });
  });

  describe("getAgentToolFunctions — empty vs populated (Req 3.2)", () => {
    it("returns an empty registry for an empty/whitespace implementation", () => {
      _internal.setLoadedToolsForTests({ implementation: "   ", schema: [] });

      expect(getAgentToolFunctions()).toEqual({});
    });

    it("returns the tools registry for an implementation that defines one", () => {
      _internal.setLoadedToolsForTests({
        implementation: `
          function alpha(args, ctx) { return { ok: true }; }
          function beta(args, ctx) { return { ok: true }; }
          const tools = { alpha, beta };
          function run(args, ctx) { return tools[ctx.toolName](args, ctx); }
        `,
        schema: [],
      });

      const fns = getAgentToolFunctions();
      expect(Object.keys(fns).sort()).toEqual(["alpha", "beta"]);
      expect(typeof fns.alpha).toBe("function");
      expect(typeof fns.beta).toBe("function");
    });

    it("returns { run } for a run-only implementation", () => {
      _internal.setLoadedToolsForTests({
        implementation: `function run(args, ctx) { return { ok: true }; }`,
        schema: [],
      });

      const fns = getAgentToolFunctions();
      expect(Object.keys(fns)).toEqual(["run"]);
      expect(typeof fns.run).toBe("function");
    });
  });

  describe("getAgentToolSchemas — last-valid retention (Req 5.8)", () => {
    it("retains the last valid tools when the schema buffer becomes invalid", () => {
      // Load a valid schema first.
      _internal.setLoadedToolsForTests({
        implementation: `function run(args, ctx) { return { ok: true }; }`,
        schema: [VALID_TOOL],
      });
      expect(getAgentToolSchemas()).toHaveLength(1);
      expect(getAgentToolSchemas()[0].function.name).toBe("greet");

      // Apply an invalid (but non-empty) schema buffer.
      _internal.setLoadedToolsForTests({
        implementation: `function run(args, ctx) { return { ok: true }; }`,
        schema: "{ this is not valid json",
      });

      // The accessor keeps returning the last valid tools.
      const schemas = getAgentToolSchemas();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].function.name).toBe("greet");
    });
  });
});
