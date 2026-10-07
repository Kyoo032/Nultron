/**
 * Reads the AI SDK's stream to learn how a tool loop ended. The SDK stops after `maxSteps` model calls
 * and says nothing when the last one asked for tools: the run just ends with tool results and no answer.
 * A step is finished at its `step-finish` part; it called a tool if a `tool-call` part came before it.
 */
export type StepTracker = {
  observe(part: unknown): void;
  stepsFinished(): number;
  /** True when `maxSteps` steps finished and the last of them ended on a tool call, so no answer followed. */
  endedAtLimit(maxSteps: number): boolean;
};

export function createStepTracker(): StepTracker {
  let finished = 0;
  let stepCalledTool = false;
  let lastStepCalledTool = false;
  return {
    observe(part) {
      const type = typeof part === "object" && part !== null ? (part as { type?: unknown }).type : undefined;
      if (type === "tool-call") {
        stepCalledTool = true;
      } else if (type === "step-finish") {
        finished += 1;
        lastStepCalledTool = stepCalledTool;
        stepCalledTool = false;
      }
    },
    stepsFinished: () => finished,
    endedAtLimit: (maxSteps) => finished >= maxSteps && lastStepCalledTool,
  };
}
