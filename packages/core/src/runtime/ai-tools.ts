import { tool as aiTool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolBindingRecord } from "../agents/service";
import { scrubUnreachableMediaArgs } from "../content/provider-media";
import type { TenantContext } from "../tenancy/types";
import { getTool } from "../tools/registry";
import { getInjectionGuardBypass } from "../tools/secret-scope";
import type { EgressGuard } from "./egress-guard";
import { disabledToolOutput, invokeToolGuarded } from "./invoke-guarded";
import type { MediaPermission } from "./media-permission";
import { isRunAbort, toolErrorResult } from "./tool-error";
import { reportToolIo } from "./tool-io";
import type { ToolBudget } from "./tool-budget";

/**
 * The tools of one model call, as the AI SDK takes them.
 * - `tools` holds every bound tool that exists, including a disabled one, so a call to a tool the run
 *   never offered still reaches `invokeToolGuarded` and comes back as its refusal. Without it the SDK
 *   cannot find the tool, throws, and the run ends.
 * - `offered` is what the model is told it can call: every tool in `tools` except the disabled ones.
 */
export type AiToolSet = {
  tools: ToolSet;
  offered: string[];
};

type ToolCallOptions = { abortSignal?: AbortSignal };

/** A disabled tool takes any arguments: the call is refused whatever it says, and must not fail first. */
const ANY_ARGUMENTS = z.any();

export function buildAiTools(options: {
  bindings: ReadonlyArray<Pick<ToolBindingRecord, "toolKey" | "enabled">>;
  tenant: TenantContext;
  /** The caller's cancel. The SDK's own signal arrives with each call and is checked as well. */
  signal?: AbortSignal | undefined;
  budget: ToolBudget;
  egress: EgressGuard;
  /** Absent for a run whose paid media is the person's own click (the studios): every call runs. */
  permission?: MediaPermission | undefined;
  disabled: ReadonlySet<string>;
}): AiToolSet {
  const tools: ToolSet = {};
  const offered: string[] = [];
  for (const binding of options.bindings.filter((item) => item.enabled)) {
    const definition = getTool(binding.toolKey);
    if (!definition || binding.toolKey in tools) {
      continue;
    }
    if (options.disabled.has(binding.toolKey)) {
      tools[binding.toolKey] = aiTool({
        description: definition.description,
        parameters: ANY_ARGUMENTS,
        execute: async (args: unknown) => {
          // The refusal spends a budget slot like any call. Without it a model (or text that steers it) could
          // call a tool that is off as often as it likes: every call is a row on the screen and a stored result.
          const refusal = options.budget.admit(definition.key) ?? disabledToolOutput(definition.key);
          reportToolIo({ toolKey: definition.key, input: args, full: refusal, thin: refusal });
          return refusal;
        },
      });
      continue;
    }
    offered.push(binding.toolKey);
    tools[binding.toolKey] = aiTool({
      description: definition.description,
      parameters: definition.schema,
      execute: async (args: unknown, call?: ToolCallOptions) => {
        const input = scrubUnreachableMediaArgs(args);
        try {
          return await invokeToolGuarded(definition, input, options.tenant, options.budget, options.egress, options.permission);
        } catch (error) {
          // A cancel ends the run. Only a failure on a live run goes back to the model to recover from.
          if (isRunAbort(options.signal, call?.abortSignal)) {
            throw error;
          }
          // Any tool can throw a third party's words (a page, a file, a gateway's error body): keep them from
          // the model when they read like instructions, whatever the tool's trust.
          const failure = toolErrorResult(error, definition.key, { scanForInstructions: !getInjectionGuardBypass() });
          reportToolIo({ toolKey: definition.key, input, full: failure, thin: failure });
          return failure;
        }
      },
    });
  }
  return { tools, offered };
}
