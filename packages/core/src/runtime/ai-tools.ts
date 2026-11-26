import { tool as aiTool, type ToolSet } from "ai";
import type { ToolBindingRecord } from "../agents/service";
import { scrubUnreachableMediaArgs } from "../content/provider-media";
import type { TenantContext } from "../tenancy/types";
import { getTool } from "../tools/registry";
import { getInjectionGuardBypass } from "../tools/secret-scope";
import type { EgressGuard } from "./egress-guard";
import { invokeToolGuarded } from "./invoke-guarded";
import type { MediaPermission } from "./media-permission";
import { isRunAbort, toolErrorResult } from "./tool-error";
import { reportToolIo } from "./tool-io";
import type { ToolBudget } from "./tool-budget";

/**
 * The tools of one model call, as the AI SDK takes them: every bound tool that exists and is not disabled.
 * A call to any other name comes back to the model from the SDK as a tool error, and the loop goes on.
 * - `offered` is the keys of `tools`.
 */
export type AiToolSet = {
  tools: ToolSet;
  offered: string[];
};

type ToolCallOptions = { abortSignal?: AbortSignal };

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
  /** The running agent, stamped on each tool.call audit row (F2). */
  agentId?: string | undefined;
}): AiToolSet {
  const tools: ToolSet = {};
  const offered: string[] = [];
  for (const binding of options.bindings.filter((item) => item.enabled)) {
    const definition = getTool(binding.toolKey);
    if (!definition || binding.toolKey in tools || options.disabled.has(binding.toolKey)) {
      continue;
    }
    offered.push(binding.toolKey);
    tools[binding.toolKey] = aiTool({
      description: definition.description,
      inputSchema: definition.schema,
      execute: async (args: unknown, call?: ToolCallOptions) => {
        const input = scrubUnreachableMediaArgs(args);
        try {
          return await invokeToolGuarded(definition, input, options.tenant, options.budget, options.egress, options.permission, options.agentId);
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
