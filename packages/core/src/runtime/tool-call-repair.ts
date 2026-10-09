import { tool as aiTool, type streamText, type ToolSet } from "ai";
import { z } from "zod";
import type { RuntimeEvent } from "./types";

/**
 * A model's tool call can be refused before any tool runs: arguments that break the tool's schema, or a
 * tool name this run does not have. The AI SDK throws while parsing such a call, the stream ends in an
 * `error` part, and the whole turn fails over a slip the model could have corrected.
 *
 * The SDK's repair hook is the way out. A call it cannot parse is rewritten into a call of
 * `invalid_tool_call`, a tool that is held by the run but never offered to the model, whose result says
 * what was wrong and which tools exist. The loop then goes on: the model reads the result as it would any
 * other and tries again or answers. Nothing here runs the tool the model asked for.
 */
export const INVALID_TOOL_CALL = "invalid_tool_call";

const REASON_MAX = 600;
const NAME_MAX = 80;

const invalidCallArguments = z.object({
  tool: z.string(),
  error: z.string(),
  available: z.array(z.string()),
});

/** `tools` plus the held-back correction tool. Pair it with `experimental_activeTools`, or the model is offered it. */
export function withInvalidToolCall(tools: ToolSet): ToolSet {
  return {
    ...tools,
    [INVALID_TOOL_CALL]: aiTool({
      description: "Internal: the result of a tool call that could not be run. Never call this.",
      parameters: invalidCallArguments,
      execute: async ({ tool, error, available }) => ({
        ok: false,
        reason: INVALID_TOOL_CALL,
        message: `The call to "${tool}" was rejected and nothing ran: ${error} Tools you can call: ${
          available.length > 0 ? available.join(", ") : "none"
        }. Call one of them with valid arguments, or answer without tools.`,
      }),
    }),
  };
}

type RepairFunction = NonNullable<Parameters<typeof streamText>[0]["experimental_repairToolCall"]>;

/** The repair hook for a run that offers `offered`. Every refused call becomes a call of the correction tool. */
export function createToolCallRepair(offered: readonly string[]): RepairFunction {
  return async ({ toolCall, error }) => {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
    return {
      type: "tool-call",
      toolCallType: "function",
      toolCallId: toolCall.toolCallId,
      toolName: INVALID_TOOL_CALL,
      args: JSON.stringify({
        tool: String(toolCall.toolName).slice(0, NAME_MAX),
        error: reason.slice(0, REASON_MAX),
        available: [...offered],
      }),
    };
  };
}

/** The correction tool's own events are the SDK talking to the model, not a tool the person's turn used. */
export function isInvalidToolCallEvent(event: RuntimeEvent): boolean {
  return (event.type === "tool.started" || event.type === "tool.completed") && event.toolKey === INVALID_TOOL_CALL;
}
