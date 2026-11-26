import type { ZodTypeAny } from "zod";
import type { TenantContext } from "../tenancy/types";
import { invokeTool, type ToolDefinition } from "../tools/define-tool";
import { getDisabledTools, getInjectionGuardBypass } from "../tools/secret-scope";
import { blockedInjectionOutput, scanJson } from "../security/injection-guard";
import { runInToolCall } from "../security/outbound-guard";
import { maskPiiInJson } from "../security/pii";
import { thinToolOutput } from "../security/tool-thin";
import type { EgressGuard } from "./egress-guard";
import { reportAuditEvent } from "../audit/sink";
import type { MediaPermission } from "./media-permission";
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
 * With a `permission` gate, `image_generate` and `video_generate` return a `permission` refusal instead of
 * running until the person has pressed Run on that request (SR-167); it too spends a budget slot.
 */
export async function invokeToolGuarded<TSchema extends ZodTypeAny>(
  tool: ToolDefinition<TSchema>,
  rawArgs: unknown,
  tenant: TenantContext,
  budget?: ToolBudget,
  egress?: EgressGuard,
  permission?: MediaPermission,
  agentId?: string,
): Promise<unknown> {
  // F2: one `tool.call` audit event per outcome — tool key, agent, outcome and duration only. The
  // strict event schema is what keeps arguments and output out of the log.
  const auditCall = (outcome: "ok" | "denied" | "failed", durationMs?: number, rule?: string) =>
    reportAuditEvent({
      tenantId: tenant.tenantId,
      event: "tool.call",
      actorKind: "user",
      actorId: tenant.userId || null,
      agentId,
      targetKind: "tool",
      targetId: tool.key,
      outcome,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(rule === undefined ? {} : { rule }),
    });

  const refusal = budget?.admit(tool.key);
  if (refusal) {
    reportToolIo({ toolKey: tool.key, input: rawArgs, full: refusal, thin: refusal });
    auditCall("denied");
    return refusal;
  }

  const permissionRefusal = permission?.beforeCall(tool.key, rawArgs);
  if (permissionRefusal) {
    reportToolIo({ toolKey: tool.key, input: rawArgs, full: permissionRefusal, thin: permissionRefusal });
    auditCall("denied");
    return permissionRefusal;
  }

  // A call the person pressed Run on runs as the card showed it, not with whatever else the model added.
  const args = permission ? permission.argsToRun(tool.key, rawArgs) : rawArgs;

  const egressRefusal = egress?.beforeCall(tool.key, args);
  if (egressRefusal) {
    reportToolIo({ toolKey: tool.key, input: rawArgs, full: egressRefusal, thin: egressRefusal });
    auditCall("denied");
    return egressRefusal;
  }

  if (getDisabledTools().includes(tool.key)) {
    const blocked = disabledToolOutput(tool.key);
    reportToolIo({ toolKey: tool.key, input: rawArgs, full: blocked, thin: blocked });
    auditCall("denied");
    return blocked;
  }

  if (!getInjectionGuardBypass()) {
    const hit = scanJson(args);
    if (hit) {
      const blocked = blockedInjectionOutput(hit);
      reportToolIo({ toolKey: tool.key, input: rawArgs, full: blocked, thin: blocked });
      auditCall("denied");
      return blocked;
    }
  }

  let full: unknown;
  const started = Date.now();
  try {
    // Marked as a model's tool call: a sender it reaches with no outbound guard open refuses (fails closed).
    full = await runInToolCall(() => invokeTool(tool, args, tenant));
  } catch (error) {
    // A tool that read private material and then failed may have quoted it in its error.
    egress?.afterCall(tool, undefined);
    auditCall("failed", Date.now() - started);
    throw error;
  }
  // Taint on what ran, not on what the model is shown: the scan below may hide the output, the read still happened.
  egress?.afterCall(tool, full);
  let thin = thinToolOutput(tool.key, full);

  let outputBlocked = false;
  if (!getInjectionGuardBypass() && tool.trust !== "internal") {
    const outputHit = scanJson(thin);
    if (outputHit) {
      thin = blockedInjectionOutput(outputHit);
      outputBlocked = true;
    }
  }

  thin = maskPiiInJson(thin);
  reportToolIo({ toolKey: tool.key, input: args, full, thin });
  const success = (full as { success?: unknown } | null | undefined)?.success;
  // The outcome records what the model was given: a call whose result was withheld by the output
  // scan is a denial to the model even though the tool itself ran clean.
  auditCall(outputBlocked ? "denied" : success === false ? "failed" : "ok", Date.now() - started, outputBlocked ? "injection_output" : undefined);
  return thin;
}
