import type { ZodTypeAny } from "zod";
import type { TenantContext } from "../tenancy/types";
import { invokeTool, type ToolDefinition } from "../tools/define-tool";
import { getDisabledTools, getInjectionGuardBypass } from "../tools/secret-scope";
import { blockedInjectionOutput, scanJson } from "../security/injection-guard";
import { runInToolCall } from "../security/outbound-guard";
import { thinToolOutput } from "../security/tool-thin";
import type { EgressGuard } from "./egress-guard";
import type { ToolBudget } from "./tool-budget";
import { reportToolIo } from "./tool-io";

/** What a call to a disabled tool gets back. Also what the runtime answers when the model calls a tool it was never offered. */
export function disabledToolOutput(toolKey: string): { success: false; error: string } {
  return { success: false, error: `Tool ${toolKey} is disabled on this machine.` };
}

/**
 * One choke for live + stub tool calls: budget, disabled-tools, injection scan, execute, thin.
 * Full output is reported to the ALS sink; the return value is thinned for the model.
 * A tool whose `trust` is not `internal` has its output scanned for injection before the model sees it.
 * With a `budget`, a call past the run's total or the tool's own ceiling returns the refusal instead of running.
 * With an `egress` guard, a `web_fetch` made after the run has read private material returns the guard's
 * refusal instead of running unless the host is one the person named or a search returned (SR-112). The
 * refused call still spends its budget slot, so a model cannot retry it without limit.
 */
export async function invokeToolGuarded<TSchema extends ZodTypeAny>(
  tool: ToolDefinition<TSchema>,
  rawArgs: unknown,
  tenant: TenantContext,
  budget?: ToolBudget,
  egress?: EgressGuard,
): Promise<unknown> {
  const refusal = budget?.admit(tool.key);
  if (refusal) {
    reportToolIo({ toolKey: tool.key, input: rawArgs, full: refusal, thin: refusal });
    return refusal;
  }

  const egressRefusal = egress?.beforeCall(tool.key, rawArgs);
  if (egressRefusal) {
    reportToolIo({ toolKey: tool.key, input: rawArgs, full: egressRefusal, thin: egressRefusal });
    return egressRefusal;
  }

  if (getDisabledTools().includes(tool.key)) {
    const blocked = disabledToolOutput(tool.key);
    reportToolIo({ toolKey: tool.key, input: rawArgs, full: blocked, thin: blocked });
    return blocked;
  }

  if (!getInjectionGuardBypass()) {
    const hit = scanJson(rawArgs);
    if (hit) {
      const blocked = blockedInjectionOutput(hit);
      reportToolIo({ toolKey: tool.key, input: rawArgs, full: blocked, thin: blocked });
      return blocked;
    }
  }

  let full: unknown;
  try {
    // Marked as a model's tool call: a sender it reaches with no outbound guard open refuses (fails closed).
    full = await runInToolCall(() => invokeTool(tool, rawArgs, tenant));
  } catch (error) {
    // A tool that read private material and then failed may have quoted it in its error.
    egress?.afterCall(tool, undefined);
    throw error;
  }
  // Taint on what ran, not on what the model is shown: the scan below may hide the output, the read still happened.
  egress?.afterCall(tool, full);
  let thin = thinToolOutput(tool.key, full);

  if (!getInjectionGuardBypass() && tool.trust !== "internal") {
    const outputHit = scanJson(thin);
    if (outputHit) {
      thin = blockedInjectionOutput(outputHit);
    }
  }

  reportToolIo({ toolKey: tool.key, input: rawArgs, full, thin });
  return thin;
}
