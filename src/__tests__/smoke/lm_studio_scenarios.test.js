// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Expanded configurable LM Studio smoke tests — exercises a matrix of
// edit scenarios against the live model and logs structured results.
//
// Run with: LLM_SMOKE=1 npm run test:smoke
//
// Environment variables:
//   LLM_SMOKE=1              Enable smoke tests
//   LLM_API_URL              LM Studio endpoint (default: http://10.0.1.5:1234/v1/chat/completions)
//   LLM_MODEL                Preferred model (auto-detected if omitted)
//   LLM_TEMPERATURE          Temperature (default: 0.1)
//   LLM_MAX_TOKENS           Max tokens (default: 2048)
//   LLM_SMOKE_TIMEOUT_MS     Per-test timeout (default: 120000)
//   LLM_SMOKE_CATEGORY       Run only a specific category (replace_line, replace_span, insert_text, etc.)
//   LLM_SMOKE_RETRIES        Max retries per scenario (default: 1)

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getSmokeConfig,
  installLmStudioBridge,
  pingLmStudio,
} from "./helpers/lm_studio_client.js";
import { runScenario } from "./helpers/smoke_runner.js";
import { ALL_SCENARIOS, allScenarios } from "./helpers/smoke_scenarios.js";
import { flushResults, clearResults } from "./helpers/smoke_logger.js";

const config = getSmokeConfig();
const smokeEnabled = config.enabled;
const categoryFilter = process.env.LLM_SMOKE_CATEGORY || null;
const maxRetries = Number(process.env.LLM_SMOKE_RETRIES ?? "1");

describe.skipIf(!smokeEnabled)("LM Studio scenario matrix", () => {
  let model = "";

  beforeAll(async () => {
    const ok = await pingLmStudio(config.apiUrl);
    if (!ok) {
      throw new Error(`LM Studio not reachable at ${config.apiUrl}`);
    }
    const bridge = await installLmStudioBridge(config);
    model = bridge.model;
    clearResults();
    console.log(`\nSmoke test model: ${model}`);
    console.log(`API URL: ${config.apiUrl}`);
    console.log(`Temperature: ${config.temperature}`);
    console.log(`Max tokens: ${config.maxTokens}`);
    console.log(`Timeout: ${config.timeoutMs}ms`);
    if (categoryFilter) {
      console.log(`Category filter: ${categoryFilter}`);
    }
    console.log("");
  }, config.timeoutMs);

  beforeEach(async () => {
    document.body.innerHTML = "";
    await installLmStudioBridge(config);
  });

  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  afterAll(() => {
    flushResults();
  });

  // Dynamically generate tests from scenario definitions
  const categories = categoryFilter
    ? { [categoryFilter]: ALL_SCENARIOS[categoryFilter] || [] }
    : ALL_SCENARIOS;

  for (const [category, scenarios] of Object.entries(categories)) {
    if (!scenarios || scenarios.length === 0) continue;

    describe(`${category} scenarios`, () => {
      for (const scenario of scenarios) {
        it(scenario.name, async () => {
          const outcome = await runScenario(scenario, {
            model,
            maxRetries,
          });
          expect(outcome.pass, outcome.reason).toBe(true);
        }, config.timeoutMs);
      }
    });
  }
});

describe("LM Studio scenarios (disabled hint)", () => {
  it.skipIf(smokeEnabled)(
    "set LLM_SMOKE=1 to run live scenario tests",
    () => {
      expect(smokeEnabled).toBe(false);
    }
  );
});
