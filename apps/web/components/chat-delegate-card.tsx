"use client";

import { useState } from "react";
import { FormattedText } from "@/components/formatted-text";
import { toolLabel } from "@/lib/harness-copy";
import { t } from "@/lib/i18n";
import { Link } from "@/lib/nav";
import { isTeamBotParam, teamBotHref } from "@/lib/team";
import { virtualAgentHref } from "@/lib/virtual-agents";
import { DELEGATE_TOOL_KEY, readDelegateResult, type DelegateCardModel } from "./tool-rows/delegate-result";

/** The card names this many of the tools the asked agent used; the rest are in its conversation. */
const TOOLS_SHOWN = 3;

type CardProps = {
  readonly model: DelegateCardModel;
  /** Starts with the answer open. For a test; a person opens it with the Show control. */
  readonly defaultOpen?: boolean;
};

/** "Web search · Read a file": the tools in the person's language, capped, with how many were left out. */
function toolsLine(tools: readonly string[]): string {
  const shown = tools.slice(0, TOOLS_SHOWN).map(toolLabel).join(" · ");
  const more = tools.length - TOOLS_SHOWN;
  return more > 0 ? t("agents.delegate.usedMore", { tools: shown, n: more }) : t("agents.delegate.used", { tools: shown });
}

/**
 * What another agent did for the one that is answering, under its answer: which agent was asked, the first
 * line of the task, the tools it used, its answer (opened with Show) and a link to the conversation that
 * holds the whole task and answer. The link is the same Chat the agent's rail opens, with the thread named,
 * so a hand-off is never hidden from the owner. Everything on the card comes from the saved tool call, so
 * a reopened thread draws the same card. A run that stopped or gave no answer says so and still links.
 */
export function DelegateCard({ model, defaultOpen = false }: CardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bot = isTeamBotParam(model.agent);
  const agent = model.agentName ?? (bot ? model.agent : t(`rail.${model.agent}`));
  const href = bot ? teamBotHref(model.agent, model.threadId) : virtualAgentHref(model.agent, model.threadId);
  const hasAnswer = model.failure === null && model.summary !== "";

  return (
    <section
      className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-3 shadow-elev-1"
      data-testid="chat-delegate-card"
      data-agent={model.agent}
      data-thread-id={model.threadId}
      data-state={model.failure === null ? "answered" : "failed"}
      data-open={open && hasAnswer ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--text-3)]">
            {t("agents.delegate.asked", { agent })}
          </p>
          {model.headline ? (
            <h4
              className="mt-0.5 break-words text-sm font-semibold text-[var(--text)] [overflow-wrap:anywhere]"
              data-testid="chat-delegate-task"
            >
              {model.headline}
            </h4>
          ) : null}
          {model.failure !== null ? (
            <p className="mt-0.5 text-xs text-[var(--danger)]" data-testid="chat-delegate-failure" data-reason={model.failure}>
              {t(`agents.delegate.failed.${model.failure}`)}
            </p>
          ) : model.toolsUsed.length > 0 ? (
            <p className="mt-0.5 min-w-0 text-xs text-[var(--text-2)] [overflow-wrap:anywhere]" data-testid="chat-delegate-tools">
              {toolsLine(model.toolsUsed)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {hasAnswer ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-label={t(open ? "agents.delegate.hideAria" : "agents.delegate.showAria", { agent })}
              data-testid="chat-delegate-toggle"
            >
              {open ? t("agents.delegate.hide") : t("agents.delegate.show")}
            </button>
          ) : null}
          <Link
            href={href}
            className="btn btn-secondary"
            aria-label={t("agents.delegate.openAria", { agent })}
            data-testid="chat-delegate-open"
          >
            {t("agents.delegate.open")}
          </Link>
        </div>
      </div>

      {open && hasAnswer ? (
        <div
          className="mt-3 max-h-[32rem] min-w-0 overflow-auto border-t border-[var(--line)] pt-3"
          role="region"
          aria-label={t("agents.delegate.viewAria", { agent })}
          data-testid="chat-delegate-view"
        >
          <FormattedText text={model.summary} className="text-sm" testId="chat-delegate-text" />
          {model.truncated ? (
            <p className="mt-2 text-xs text-[var(--text-3)]" data-testid="chat-delegate-truncated">
              {t("agents.delegate.truncated")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type ToolCall = { readonly key: string; readonly status: string; readonly input?: unknown; readonly output?: unknown };

/** One card for each finished `delegate` call of this turn that started a run. */
export function DelegateCards({ tools }: { readonly tools: readonly ToolCall[] }) {
  const hands = tools.flatMap((tool) => {
    if (tool.key !== DELEGATE_TOOL_KEY || tool.status !== "completed") {
      return [];
    }
    const model = readDelegateResult(tool.input, tool.output);
    return model ? [model] : [];
  });
  if (hands.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-testid="chat-delegate-cards">
      {hands.map((model) => (
        <DelegateCard key={model.threadId} model={model} />
      ))}
    </div>
  );
}

/** The name the Chat turn and the other lanes import. */
export { DelegateCard as ChatDelegateCard };
