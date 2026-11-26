/**
 * The headless reply run (F5b): one inbound mail becomes a user turn on the mail thread's chat
 * thread, the run's answer becomes the mail's reply. Modelled on `voice/ask.ts` — same
 * `prepareChatRun` + `createRuntime` + `assistant.delta` collection — but the turns are stored:
 * both the mail's text and the answer go into the sealed message store (`insertMessage`), the one
 * place mail bodies may live (S1, 0030's comment).
 *
 * The run keeps what exists on this branch — RBAC and the desk's model through `prepareChatRun`,
 * the injection scan through `scanInjection` before the text reaches the model, the audit trail
 * through `reportAuditEvent`, the outbound guard around the runtime. F4's flags and F9's metering
 * attach where they already sit inside `prepareChatRun`/`recordChatRunUsage`.
 */
import {
  DELEGATE_PER_TURN,
  DELEGATE_TOOL_KEY,
  attachedTextsOf,
  createOutboundGuard,
  createRuntime,
  hasNonTextUserPart,
  runOutboundGuarded,
  scanInjection,
  userTextOf,
  type ContentPart,
  type RunBudget,
  type RuntimeEvent,
  type TenantContext,
} from "@agentforge/core";
import { prepareChatImageHistory } from "../../chat-image-history";
import { requireGatewayAllowedFor } from "../../gateway-gate";
import { log } from "../../log";
import { chatHistoryFromRows, prepareChatRun } from "../../runs";
import { admitRun } from "../../run-limits";
import { withRunContext } from "../../run-context";
import { currentAssignedGatewayEndpoint, withAssignedGatewayEndpoint } from "../../gateway-endpoint-scope";
import { toolMediaModels } from "../../selectable-models";
import { insertMessage, listMessages } from "../../threads";
import { withToolRun } from "../../tool-run-context";
import { recordChatRunUsage } from "../../usage-record";
import { withWorkerChannel } from "../../workers/worker-channel";

export type EmailRunResult =
  | { kind: "answered"; text: string }
  | { kind: "refused"; reason: "injection" | "gateway_blocked" | "busy" | "failed" };

/** A mail gets one read and an answer — voice's budget, minus the `delegate` tool (none is bound). */
const EMAIL_BUDGET: RunBudget = Object.freeze({
  maxSteps: 5,
  maxToolCalls: 6,
  perTool: Object.freeze({ [DELEGATE_TOOL_KEY]: DELEGATE_PER_TURN }),
});

const EMAIL_TIMEOUT_MS = 120_000;

/** A mail is a system-context user turn; its provenance is stated, its body stays the only content. */
const EMAIL_PROMPT_PREFIX =
  "The following turn arrived as an e-mail to this agent's address. Answer it as the reply to that e-mail — plain text, no markup the mail client would not render.\n\n";

export async function runEmailReply(input: {
  tenant: TenantContext;
  threadId: string;
  /** The sender's mail body, already size-capped by the webhook. */
  body: string;
  locale?: "en" | "id";
}): Promise<EmailRunResult> {
  const { tenant, threadId, body } = input;
  const locale: "en" | "id" = input.locale ?? "en";

  const scan = scanInjection(body);
  if (scan) {
    return { kind: "refused", reason: "injection" };
  }

  try {
    requireGatewayAllowedFor(tenant);
  } catch {
    return { kind: "refused", reason: "gateway_blocked" };
  }
  const release = admitRun(tenant);
  if (!release) {
    return { kind: "refused", reason: "busy" };
  }

  const run = new AbortController();
  const timer = setTimeout(() => run.abort(new Error("email_run_timeout")), EMAIL_TIMEOUT_MS);
  const stopped = new Promise<"stopped">((resolve) =>
    run.signal.addEventListener("abort", () => resolve("stopped"), { once: true }),
  );

  try {
    // The inbound mail is stored first — the user's turn — even when the run then refuses, so the
    // thread reads like the mailbox did. Content is sealed by insertMessage.
    const userParts: ContentPart[] = [{ type: "text", text: body }];
    await insertMessage(tenant, threadId, "user", userParts);

    const runId = `email-${crypto.randomUUID()}`;
    const state = { answer: "", failed: false, usageRecorded: false };

    const job = (async (): Promise<void> => {
      const prepared = await prepareChatRun({
        tenant,
        threadId,
        modality: "text",
        body: { content: EMAIL_PROMPT_PREFIX + body, reasoningEffort: "low" },
        locale,
      });
      const rows = await listMessages(tenant, threadId);
      const history = await prepareChatImageHistory(
        tenant,
        [...chatHistoryFromRows(rows.slice(0, -1)), { role: "user" as const, parts: prepared.userParts }],
        { model: prepared.version.model, locale },
      );
      const runtime = createRuntime(prepared.settings, toolMediaModels(tenant));
      const outbound = createOutboundGuard({
        userText: userTextOf(history),
        privateText: [...prepared.knowledge.privateText, ...attachedTextsOf(history)],
        figuresOnlyText: [prepared.pastHint],
        tainted: hasNonTextUserPart(history),
        locale,
      });
      const onEvent = (event: RuntimeEvent) => {
        if (event.type === "assistant.delta") {
          state.answer += event.text;
        } else if (event.type === "run.completed") {
          state.usageRecorded = true;
          try {
            recordChatRunUsage(tenant, runId, true, (event.usage as Record<string, unknown> | undefined) ?? null);
          } catch {
            // The ledger never fails the reply.
          }
        }
      };
      await withAssignedGatewayEndpoint(tenant.gatewayEndpoint ?? currentAssignedGatewayEndpoint(), () =>
        withToolRun({ runId, mode: prepared.agentPolicy ? prepared.agentPolicy.agent.id : "chat" }, () =>
          withRunContext({ threadId: prepared.thread.id, agentId: prepared.thread.agentId, locale }, () =>
            runOutboundGuarded(outbound, () =>
              withWorkerChannel({ emit: () => undefined, signal: run.signal }, () =>
                runtime.execute({
                  tenant,
                  runId,
                  modality: "text",
                  version: prepared.version,
                  bindings: prepared.bindings,
                  budget: EMAIL_BUDGET,
                  history,
                  mediaPermission: prepared.mediaPermission,
                  thinking: prepared.thinkingEnabled,
                  reasoningEffort: prepared.reasoningEffort,
                  reasoningEffortExplicit: prepared.reasoningEffortExplicit,
                  wire: prepared.wire,
                  locale,
                  signal: run.signal,
                  onEvent,
                }),
              ),
            ),
          ),
        ),
      );
    })();

    await Promise.race([job, stopped]).catch(() => {
      state.failed = true;
    });
    const text = state.answer.trim();
    if (!text || state.failed || run.signal.aborted) {
      return { kind: "refused", reason: "failed" };
    }
    // The answer is stored as the thread's assistant turn — the sealed store again — before it is mailed.
    await insertMessage(tenant, threadId, "assistant", [{ type: "text", text }]);
    return { kind: "answered", text };
  } catch (error) {
    log.warn("email_run_failed", { detail: error instanceof Error ? error.name : "unknown" });
    return { kind: "refused", reason: "failed" };
  } finally {
    clearTimeout(timer);
    release();
  }
}
