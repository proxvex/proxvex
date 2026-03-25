/**
 * Shared logging helpers for the live integration test runner.
 * Provides colored console output for test steps and results.
 */

// ── Colors ──

export const RED = "\x1b[0;31m";
export const GREEN = "\x1b[0;32m";
export const YELLOW = "\x1b[1;33m";
export const BLUE = "\x1b[0;34m";
export const NC = "\x1b[0m";

export function logOk(msg: string) { console.log(`${GREEN}\u2713${NC} ${msg}`); }
export function logFail(msg: string) { console.log(`${RED}\u2717${NC} ${msg}`); }
export function logWarn(msg: string) { console.log(`${YELLOW}!${NC} ${msg}`); }
export function logInfo(msg: string) { console.log(`\u2192 ${msg}`); }
export function logStep(step: string, desc: string) {
  console.log(`\n${BLUE}\u2500\u2500 ${step}: ${desc} \u2500\u2500${NC}`);
}
