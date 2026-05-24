// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// Structured logging for smoke test results — captures LLM responses,
// tool calls, validation outcomes, and timing for post-run analysis.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "smoke-results");

/**
 * @typedef {{
 *   scenario: string,
 *   tool: string,
 *   prompt: string,
 *   document: string,
 *   result: string,
 *   pass: boolean,
 *   reason: string,
 *   durationMs: number,
 *   agentTurns: number,
 *   toolCalls: Array<{ name: string, args: string }>,
 *   assistantMessages: string[],
 *   errors: string[],
 *   attempt: number,
 *   model: string,
 *   timestamp: string,
 * }} SmokeLogEntry
 */

/** @type {SmokeLogEntry[]} */
const entries = [];

/**
 * Record a smoke test result.
 *
 * @param {SmokeLogEntry} entry
 * @returns {void}
 */
export function logResult(entry) {
  entries.push(entry);
  const icon = entry.pass ? "✓" : "✗";
  const duration = `${entry.durationMs}ms`;
  const turns = `${entry.agentTurns} turn(s)`;
  console.log(
    `  ${icon} [${entry.tool}] ${entry.scenario} — ${entry.reason} (${duration}, ${turns})`
  );
  if (!entry.pass) {
    console.log(`    Prompt: ${entry.prompt.slice(0, 120)}…`);
    console.log(`    Result (first 200 chars): ${entry.result.slice(0, 200)}`);
    if (entry.errors.length > 0) {
      console.log(`    Errors: ${entry.errors.join("; ")}`);
    }
    if (entry.toolCalls.length > 0) {
      for (const tc of entry.toolCalls) {
        console.log(`    Tool call: ${tc.name}(${tc.args.slice(0, 100)})`);
      }
    }
  }
}

/**
 * Write all accumulated results to a JSON file for analysis.
 *
 * @returns {string} path to the written file
 */
export function flushResults() {
  if (entries.length === 0) return "";
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `smoke-${timestamp}.json`;
  const filepath = join(LOG_DIR, filename);
  const summary = {
    total: entries.length,
    passed: entries.filter((e) => e.pass).length,
    failed: entries.filter((e) => !e.pass).length,
    entries,
  };
  writeFileSync(filepath, JSON.stringify(summary, null, 2));
  console.log(`\nSmoke results written to: ${filepath}`);
  console.log(
    `  Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}`
  );
  return filepath;
}

/**
 * Get a summary of results so far.
 *
 * @returns {{ total: number, passed: number, failed: number, entries: SmokeLogEntry[] }}
 */
export function getSummary() {
  return {
    total: entries.length,
    passed: entries.filter((e) => e.pass).length,
    failed: entries.filter((e) => !e.pass).length,
    entries: [...entries],
  };
}

/**
 * Clear accumulated entries (useful between test runs).
 *
 * @returns {void}
 */
export function clearResults() {
  entries.length = 0;
}
