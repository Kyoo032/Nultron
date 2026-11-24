"use client";

import { useMemo, useState, type FormEvent } from "react";
import { ArtifactActions } from "@/components/artifact-actions";
import { ArtifactPicker } from "@/components/artifact-picker";
import { Confetti } from "@/components/confetti";
import { EnhancePromptButton } from "@/components/enhance-prompt-button";
import { FormattedText } from "@/components/formatted-text";
import { JobProgressList } from "@/components/job-progress";
import { ModeIcon } from "@/components/mode-icons";
import { ModelSelect } from "@/components/model-select";
import { NeedsKeyNote } from "@/components/needs-key-note";
import { ResearchChecksNote } from "@/components/research-checks-note";
import { ResearchPreview } from "@/components/research-preview";
import { StudioEmptyDesk } from "@/components/studio-empty-desk";
import { WorkingStatus } from "@/components/working-status";
import { isGatewayBlockedText } from "@/lib/gateway-blocked";
import { t } from "@/lib/i18n";
import { modelPickBody, studioModelPick } from "@/lib/model-choice";
import { Link } from "@/lib/nav";
import { researchChecksNote, type ResearchChecksNoteModel } from "@/lib/research-checks-view";
import { researchNotesToMarkdown, type ResearchNotes } from "@/lib/research-notes";
import { localizedLibrary } from "@/lib/ui-copy";
import { useHostedNeedsKey } from "@/lib/use-desk-needs-key";
import { useJobModel } from "@/lib/use-job-model";
import { useJobStream } from "@/lib/use-job-stream";
import "@/components/studio-minimal.css";

type ResearchResult = ResearchNotes & {
  artifactId: string | null;
  dossierId?: string | null;
  dossier?: { title: string; markdown: string };
  checks?: unknown;
};

type Shown =
  | {
      kind: "run";
      notes: ResearchNotes;
      dossierMarkdown: string;
      artifactId: string | null;
      checks: ResearchChecksNoteModel | null;
    }
  | { kind: "saved"; title: string; markdown: string; artifactId: string; checks: ResearchChecksNoteModel | null };

type Tab = "notes" | "dossier";

function needsSettingsHint(message: string): boolean {
  return /gateway|api key|settings|runtime_stub|live gateway|tavily|brave/i.test(message);
}

function tabClass(active: boolean): string {
  return active
    ? "select-row wash inline-flex h-8 items-center rounded-pill bg-[var(--accent)] px-3.5 text-xs font-medium text-[var(--surface)]"
    : "wash inline-flex h-8 items-center rounded-pill border border-[var(--line)] bg-transparent px-3.5 text-xs text-[var(--text)] hover:bg-[var(--accent-soft)]";
}

export function ResearchStudio() {
  const needsKey = useHostedNeedsKey();
  const { models, model, pinned: modelPinned, setModel } = useJobModel("research");
  const job = useJobStream<ResearchResult>();
  const [prompt, setPrompt] = useState("");
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [tab, setTab] = useState<Tab>("notes");
  const [landed, setLanded] = useState(0);
  const error = job.error?.message ?? null;

  const starters = useMemo(() => localizedLibrary("research"), []);

  async function onGenerate(event: FormEvent) {
    event.preventDefault();
    const topic = prompt.trim();
    if (!topic || job.busy || needsKey) {
      return;
    }
    const result = await job.run("/api/v1/research/stream", {
      prompt: topic,
      ...modelPickBody(studioModelPick(model, modelPinned)),
    });
    if (result) {
      const { artifactId, dossierId, dossier, checks, ...notes } = result;
      setShown({
        kind: "run",
        notes,
        dossierMarkdown: dossier?.markdown ?? researchNotesToMarkdown(notes),
        artifactId: dossierId ?? artifactId,
        checks: researchChecksNote(checks),
      });
      setLanded((count) => count + 1);
      setTab("notes");
    }
  }

  const title = shown?.kind === "run" ? shown.notes.title : (shown?.title ?? "");
  const markdown = shown?.kind === "run" ? shown.dossierMarkdown : (shown?.markdown ?? "");
  const showStarters = !shown && !job.busy && starters.length > 0;

  return (
    <main data-mode="research" className="studio-shell" data-testid="research-studio">
      <header className="studio-head">
        <div className="studio-head-main">
          <span className="studio-head-icon" aria-hidden="true">
            <ModeIcon name="research" size={18} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="studio-head-title">{t("research.title")}</h1>
            <p className="studio-head-sub">{t("research.expectedInputs")}</p>
          </div>
        </div>
        <ArtifactPicker
          mode="research"
          label={t("research.reopenSaved")}
          disabled={job.busy}
          testId="research-saved"
          onPick={(artifact) => {
            setShown({
              kind: "saved",
              title: artifact.title,
              markdown: artifact.body,
              artifactId: artifact.id,
              checks: researchChecksNote(artifact.meta.checks),
            });
            setTab("dossier");
          }}
        />
      </header>

      {error && !isGatewayBlockedText(error) ? (
        <div
          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--danger)]"
          role="alert"
          data-testid="research-error"
        >
          {error}
          {needsSettingsHint(error) && !/settings/i.test(error) ? (
            <>
              {" "}
              <Link href="/settings" className="underline">
                {t("research.openSettings")}
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      <form
        className="studio-composer"
        onSubmit={(event) => void onGenerate(event)}
        data-testid="research-studio-prompt-bar"
      >
        <div className="studio-composer-top">
          <input
            type="text"
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              setSelectedExampleId(null);
            }}
            className="studio-composer-input"
            placeholder={t("research.promptPlaceholder")}
            disabled={job.busy}
            data-testid="research-prompt"
            aria-label={t("research.promptAria")}
          />
          <EnhancePromptButton
            text={prompt}
            surface="research"
            model={model}
            disabled={job.busy}
            testId="research-enhance"
            onApply={setPrompt}
          />
          {job.busy ? (
            <button
              type="button"
              className="studio-pill-toggle"
              onClick={job.cancel}
              data-testid="research-cancel"
            >
              {t("research.cancel")}
            </button>
          ) : null}
          <button
            type="submit"
            className="btn btn-primary h-9 shrink-0 rounded-pill px-4"
            disabled={job.busy || !prompt.trim() || needsKey}
            data-testid="research-generate"
          >
            {job.busy ? <WorkingStatus label={t("research.working")} /> : t("research.generate")}
          </button>
        </div>

        <div className="studio-composer-bar">
          <ModelSelect
            models={models}
            value={model}
            onChange={setModel}
            disabled={job.busy || models.length === 0}
            testId="research-studio-model"
            variant="pill"
            prefix={t("research.modelLabel")}
            ariaLabel={t("research.modelLabel")}
          />
        </div>

        {needsKey ? (
          <div className="studio-composer-notes">
            <NeedsKeyNote testId="research-needs-key" />
          </div>
        ) : null}
      </form>

      {showStarters ? (
        <div
          className="studio-chips-row"
          aria-label={t("research.examplesHeading")}
          data-testid="example-gallery"
        >
          {starters.map((entry) => (
            <button
              key={entry.exampleId}
              type="button"
              className="studio-chip"
              data-testid="example-card"
              data-example-id={entry.exampleId}
              aria-pressed={selectedExampleId === entry.exampleId}
              title={entry.resultSummary}
              disabled={job.busy}
              onClick={() => {
                setSelectedExampleId(entry.exampleId);
                setPrompt(entry.prompt);
              }}
            >
              {entry.title}
            </button>
          ))}
        </div>
      ) : null}

      {job.busy || (job.progress.phases.length > 0 && !shown) ? (
        <JobProgressList progress={job.progress} busy={job.busy} mode="research" testId="research-progress" elapsed />
      ) : null}

      {shown || job.busy || job.progress.phases.length > 0 ? null : <StudioEmptyDesk mode="research" />}

      {shown ? (
        <div className="enter-rise relative space-y-4 pt-2">
          {landed > 0 ? <Confetti key={landed} /> : null}
          <ArtifactActions
            title={title}
            markdown={markdown}
            artifactId={shown.artifactId}
            kbType="Dossier"
            disabled={job.busy}
            testIdPrefix="research"
          />
          <ResearchChecksNote note={shown.checks} />
          {shown.kind === "run" ? (
            <div className="flex gap-2" role="tablist" data-testid="research-tabs">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "notes"}
                className={tabClass(tab === "notes")}
                onClick={() => setTab("notes")}
                data-testid="research-tab-notes"
              >
                {t("research.tabNotes")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "dossier"}
                className={tabClass(tab === "dossier")}
                onClick={() => setTab("dossier")}
                data-testid="research-tab-dossier"
              >
                {t("research.tabDossier")}
              </button>
            </div>
          ) : null}
          {shown.kind === "run" && tab === "notes" ? (
            <ResearchPreview notes={shown.notes} />
          ) : (
            <article
              className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-8 py-10"
              data-testid="research-dossier-preview"
            >
              <FormattedText text={markdown} className="text-sm leading-relaxed text-[var(--text-2)]" />
            </article>
          )}
        </div>
      ) : null}
    </main>
  );
}
