"use client";

import { useState } from "react";
import type { ProductMode } from "@agentforge/core/product-modes";
import { ModeHeader } from "@/components/mode-header";
import { NeedsKeyNote } from "@/components/needs-key-note";
import { toolLabel } from "@/lib/harness-copy";
import { t } from "@/lib/i18n";
import { useRouter } from "@/lib/nav";
import {
  createMadeAgent,
  draftMadeAgent,
  madeAgentHref,
  type AgentDraftFields,
  type DraftAnswer,
  type MadeAgentFailure,
} from "@/lib/virtual-agents-made";
import "./agent-made.css";

export type DraftTool = { key: string; on: boolean };

export type DraftState = {
  name: string;
  description: string;
  instructions: string;
  baseMode: ProductMode;
  tools: DraftTool[];
  source: "live" | "stub";
};

export function toDraftState(answer: DraftAnswer): DraftState {
  return {
    name: answer.draft.name,
    description: answer.draft.description,
    instructions: answer.draft.instructions,
    baseMode: answer.draft.baseMode,
    tools: answer.draft.tools.map((key) => ({ key, on: true })),
    source: answer.source,
  };
}

export function draftFields(state: DraftState): AgentDraftFields | null {
  const name = state.name.trim();
  const instructions = state.instructions.trim();
  if (name.length === 0 || instructions.length === 0) {
    return null;
  }
  return {
    name,
    description: state.description.trim(),
    instructions,
    baseMode: state.baseMode,
    tools: state.tools.filter((tool) => tool.on).map((tool) => tool.key),
  };
}

type DraftPatch = Partial<Pick<DraftState, "name" | "description" | "instructions">>;

export type AgentNewViewProps = {
  prompt: string;
  onPromptChange: (value: string) => void;
  onDraft: () => void;
  drafting: boolean;
  draft: DraftState | null;
  onDraftChange: (patch: DraftPatch) => void;
  onToolToggle: (key: string) => void;
  canCreate: boolean;
  onCreate: () => void;
  creating: boolean;
  failure: MadeAgentFailure | null;
};

function AgentNewFailure({ failure }: { failure: MadeAgentFailure }) {
  if (failure.kind === "gateway") {
    return <NeedsKeyNote testId="agent-new-needs-key" className="agent-new-note" />;
  }
  return (
    <p role="alert" className="agent-new-error" data-testid="agent-new-error">
      {t(failure.key)}
    </p>
  );
}

export function AgentNewView({
  prompt,
  onPromptChange,
  onDraft,
  drafting,
  draft,
  onDraftChange,
  onToolToggle,
  canCreate,
  onCreate,
  creating,
  failure,
}: AgentNewViewProps) {
  const busy = drafting || creating;
  return (
    <main className="agent-new-page" data-testid="agent-new-page" aria-busy={busy || undefined}>
      <ModeHeader
        icon="chat"
        title={t("agents.new.title")}
        shapes={false}
        outcomeTestId="agent-new-lede"
        outcome={t("agents.new.lede")}
      />
      <section className="agent-new-prompt" data-testid="agent-new-prompt">
        <label className="agent-new-label" htmlFor="agent-new-prompt-input">
          {t("agents.new.promptLabel")}
        </label>
        <textarea
          id="agent-new-prompt-input"
          className="agent-new-textarea"
          data-testid="agent-new-prompt-input"
          rows={4}
          maxLength={2000}
          value={prompt}
          placeholder={t("agents.new.promptPlaceholder")}
          onChange={(event) => onPromptChange(event.target.value)}
        />
        <div className="agent-new-actions">
          <button
            type="button"
            className="agent-made-primary"
            data-testid="agent-new-draft"
            disabled={busy || prompt.trim().length === 0}
            onClick={onDraft}
          >
            {drafting ? t("agents.new.drafting") : t("agents.new.draft")}
          </button>
        </div>
      </section>
      {failure ? <AgentNewFailure failure={failure} /> : null}
      {draft ? (
        <section
          className="agent-new-draft"
          data-testid="agent-new-draft-section"
          aria-label={t("agents.new.draftTitle")}
        >
          <h2 className="agent-new-draft-title">{t("agents.new.draftTitle")}</h2>
          {draft.source === "stub" ? (
            <p className="agent-new-note" data-testid="agent-new-stub">
              {t("agents.made.stubNote")}
            </p>
          ) : null}
          <label className="agent-new-label" htmlFor="agent-new-name">
            {t("agents.new.name")}
          </label>
          <input
            id="agent-new-name"
            className="agent-new-input"
            data-testid="agent-new-name"
            maxLength={80}
            value={draft.name}
            onChange={(event) => onDraftChange({ name: event.target.value })}
          />
          <label className="agent-new-label" htmlFor="agent-new-description">
            {t("agents.new.description")}
          </label>
          <input
            id="agent-new-description"
            className="agent-new-input"
            data-testid="agent-new-description"
            maxLength={200}
            value={draft.description}
            onChange={(event) => onDraftChange({ description: event.target.value })}
          />
          <label className="agent-new-label" htmlFor="agent-new-instructions">
            {t("agents.new.instructions")}
          </label>
          <textarea
            id="agent-new-instructions"
            className="agent-new-textarea"
            data-testid="agent-new-instructions"
            rows={8}
            maxLength={6000}
            value={draft.instructions}
            onChange={(event) => onDraftChange({ instructions: event.target.value })}
          />
          <details className="agent-new-more" data-testid="agent-new-more">
            <summary>{t("agents.new.more")}</summary>
            <p className="agent-new-base" data-testid="agent-new-base">
              {t("agents.new.baseMode")}: {t(`rail.${draft.baseMode}`)}
            </p>
            <fieldset className="agent-new-tools" data-testid="agent-new-tools">
              <legend>{t("agents.new.tools")}</legend>
              {draft.tools.length === 0 ? <p className="agent-new-note">{t("agents.new.toolsNone")}</p> : null}
              {draft.tools.map((tool) => (
                <label key={tool.key} className="agent-new-tool">
                  <input
                    type="checkbox"
                    checked={tool.on}
                    data-testid={`agent-new-tool-${tool.key}`}
                    onChange={() => onToolToggle(tool.key)}
                  />
                  <span>{toolLabel(tool.key)}</span>
                </label>
              ))}
            </fieldset>
          </details>
          <div className="agent-new-actions">
            <button
              type="button"
              className="agent-made-primary"
              data-testid="agent-new-create"
              disabled={!canCreate || busy}
              onClick={onCreate}
            >
              {creating ? t("agents.new.creating") : t("agents.new.create")}
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

export function AgentNewPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<MadeAgentFailure | null>(null);
  const fields = draft ? draftFields(draft) : null;

  async function onDraft() {
    const text = prompt.trim();
    if (drafting || text.length === 0) {
      return;
    }
    setDrafting(true);
    setFailure(null);
    const result = await draftMadeAgent(text);
    setDrafting(false);
    if (result.ok) {
      setDraft(toDraftState(result.answer));
    } else {
      setFailure(result.failure);
    }
  }

  async function onCreate() {
    if (!fields || creating) {
      return;
    }
    setCreating(true);
    setFailure(null);
    const result = await createMadeAgent(fields);
    if (result.ok) {
      router.push(madeAgentHref(result.agent.id));
      return;
    }
    setCreating(false);
    setFailure(result.failure);
  }

  return (
    <AgentNewView
      prompt={prompt}
      onPromptChange={setPrompt}
      onDraft={() => void onDraft()}
      drafting={drafting}
      draft={draft}
      onDraftChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
      onToolToggle={(key) =>
        setDraft((current) =>
          current
            ? {
                ...current,
                tools: current.tools.map((tool) => (tool.key === key ? { ...tool, on: !tool.on } : tool)),
              }
            : current,
        )
      }
      canCreate={fields !== null}
      onCreate={() => void onCreate()}
      creating={creating}
      failure={failure}
    />
  );
}
