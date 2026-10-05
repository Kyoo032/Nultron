import type { ProductMode } from "../agents/product-modes";
import type { HarnessSkill } from "./mode-skills";

/**
 * How a mode drives the model. `agent` lets the model call tools in a loop; `pipeline` is host code
 * that calls the model at fixed stages; `media` calls a generation endpoint with no model loop;
 * `none` never calls the gateway.
 */
export type HarnessLoop = "agent" | "pipeline" | "media" | "none";

export type RunBudget = {
  /** Model steps in one `execute` (the SDK's `maxSteps`). */
  readonly maxSteps: number;
  /** Tool calls across the whole run, every tool counted. */
  readonly maxToolCalls: number;
  /** Per-tool ceilings inside `maxToolCalls`, keyed by tool key. */
  readonly perTool?: Readonly<Record<string, number>>;
};

export type ModeHarnessSpec = {
  readonly mode: ProductMode;
  readonly loop: HarnessLoop;
  /** The least-privilege set this mode may bind. A run never gets a tool outside it. */
  readonly tools: readonly string[];
  readonly budget: RunBudget;
  /** Check-and-repair rounds before the run fails. 0 means checks report but never repair. */
  readonly repairRounds: number;
  readonly skills: readonly HarnessSkill[];
};

/** A check's verdict. A failure is a repair note the model gets back as ERROR / WHY / FIX. */
export type CheckVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly check: string;
      readonly error: string;
      readonly why: string;
      readonly fix: string;
    };

export type OutputCheck<T> = {
  readonly id: string;
  run(output: T): CheckVerdict | Promise<CheckVerdict>;
};

/** What a tool returns, instead of running, once its budget is spent. */
export type BudgetRefusal = {
  readonly ok: false;
  readonly reason: "budget";
  readonly message: string;
};
