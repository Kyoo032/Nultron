import { redactSecretsDeep, type RuntimeEvent } from "@agentforge/core";

/**
 * The copy of a tool event that may leave the runtime: streamed to the screen, kept in the thread and
 * the `tool_invocations` rows. A tool's input is what the model chose to send (it may hold a key the
 * person pasted) and its output is what the world sent back (a page can echo a header). Neither is
 * the model's own working copy: the runtime already gave the model the real result, and this does
 * not touch that. Any event that is not a tool call or its result is returned as it came.
 */
export function redactToolEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.type === "tool.started") {
    return { ...event, input: redactSecretsDeep(event.input) };
  }
  if (event.type === "tool.completed") {
    return { ...event, output: redactSecretsDeep(event.output) };
  }
  return event;
}
