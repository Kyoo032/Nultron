import { redactSecrets, redactSecretsDeep, type RuntimeEvent } from "@agentforge/core";
import { redactToolEvent } from "../chat-tool-events";

/**
 * What leaves the Edit agent's stream for the screen. A tool's input and output are the redacted copy Chat sends
 * (`redactToolEvent`), and a failure's own words are masked as Chat masks them. The runtime's event is not changed.
 */
export function screenEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.type === "run.failed" || event.type === "run.interrupted") {
    return { ...event, message: redactSecrets(event.message) };
  }
  return redactToolEvent(event);
}

export type ScreenedToolCompleted = Extract<RuntimeEvent, { type: "tool.completed" }>;

/**
 * The copy of a finished tool call that may leave the Edit stream. Every `tool.completed` the stream sends is this
 * copy, and every frame read from a tool's output (`edit.ops`, `edit.card`, `edit.job`, `edit.plan`) is built from
 * its `output`, never from the raw result. The output is what `redactToolEvent` gives a `tool.completed` (the same
 * rule Chat uses, pinned by `tool-screen.test.ts`): credentials are masked, and a link the timeline needs stays.
 *
 * The raw result is not changed. The model and the harness still read it, and decisions (a job accepted, a spend
 * refused, a retry) are made on it.
 */
export function screenToolCompleted(toolKey: string, output: unknown): ScreenedToolCompleted {
  return { type: "tool.completed", toolKey, output: redactSecretsDeep(output) };
}
