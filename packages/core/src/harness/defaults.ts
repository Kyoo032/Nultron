import type { RunBudget } from "./spec";

/** The SDK step ceiling every tool-bound run has today (`ai-sdk-runtime.ts`: `maxSteps: 6`). */
export const DEFAULT_MAX_STEPS = 6;

/**
 * A ceiling no six-step run reaches. The runtime counts no tool calls today, so this number changes
 * nothing until a later unit enforces it; ten parallel calls in each of the six steps is far above
 * what any mode makes and keeps that unit from refusing a run that works now. A mode that gets a
 * tighter, measured cap sets its own budget in its spec file.
 */
export const DEFAULT_MAX_TOOL_CALLS = 60;

export const DEFAULT_RUN_BUDGET: RunBudget = Object.freeze({
  maxSteps: DEFAULT_MAX_STEPS,
  maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
});
