"use client";

import { useEffect, useState, type FormEvent } from "react";
import { messageUnlessBlocked } from "@/lib/gateway-blocked";
import { Link } from "@/lib/nav";
import { Confetti } from "@/components/confetti";
import { DocumentChecksNote } from "@/components/document-checks-note";
import { DocumentPreview } from "@/components/document-preview";
import { DeskSourcePicker } from "@/components/desk-source-picker";
import { MascotSlot } from "@/components/mascot-slot";
import { SourceMaterialField } from "@/components/source-material-field";
import { StudioEmptyDesk } from "@/components/studio-empty-desk";
import { WorkingStatus } from "@/components/working-status";
import { subscribeModeHandoff } from "@/lib/mode-handoff";
import { EnhancePromptButton } from "@/components/enhance-prompt-button";
import { ExampleGallery } from "@/components/example-gallery";
import { ModelSelect } from "@/components/model-select";
import { ModeHeader } from "@/components/mode-header";
import type { JobRegenSubmit } from "@/components/job-regen-panel";
import type { DocumentDraft } from "@/lib/document-outline";
import { checksNote, sourceFilesBody, splitDraftResponse, type DocumentChecksView } from "@/lib/documents-desk-sources";
import { documentStarters } from "@/lib/job-starters";
import { t } from "@/lib/i18n";
import { PROMPT_INPUT, PROMPT_ROW, PROMPT_SUBMIT } from "@/lib/prompt-row";
import { useJobModel } from "@/lib/use-job-model";
import { modelPickBody, regenModelPick, studioModelPick } from "@/lib/model-choice";
import { apiFetch, isElectron } from "@/lib/api-client";
import { filenameFromDisposition } from "@/lib/download-name";
import { isGatewayBlockedText } from "@/lib/gateway-blocked";
import { NeedsKeyNote } from "@/components/needs-key-note";
import { hostedKeyBlock, useDeskNeedsKey } from "@/lib/use-desk-needs-key";

function errorMessage(payload: unknown, fallback: string): string {
  // Hosted only: a 403 gateway_blocked is "no usable key", said as the catalog sentence (`gateway-blocked.ts`).
  const blocked = messageUnlessBlocked(payload, () => "");
  if (blocked) {
    return blocked;
  }
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
  }
  return fallback;
}

function needsSettingsHint(message: string): string {
  return /gateway|api key|settings|runtime_stub|live gateway/i.test(message) ? message : message;
}

export function DocumentsStudio() {
  const needsKey = useDeskNeedsKey();
  // Nultron Enterprise: the same fact, but only on the hosted build, where a signed-in tenant may open
  // the desk before adding a key. It swaps the plain note below for one with a Settings link and
  // replaces the generic error a refused call would print.
  const keyBlocked = hostedKeyBlock(needsKey);
  const { models, model, pinned: modelPinned, setModel } = useJobModel("documents");
  const [prompt, setPrompt] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceTitle, setSourceTitle] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocumentDraft | null>(null);
  const [busy, setBusy] = useState<"generate" | "download" | "regen" | "check" | null>(null);
  const [regenIndex, setRegenIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [landed, setLanded] = useState(0);
  const [sourceCheck, setSourceCheck] = useState<{
    checked: boolean;
    reason?: string;
    items: Array<{ sentence: string; supported: boolean }>;
  } | null>(null);
  // Desk files picked as sources: the host reads them when the request is sent.
  const [deskSources, setDeskSources] = useState<string[]>([]);
  const [deskRefresh, setDeskRefresh] = useState(0);
  // What the host's checks still found after their repair round; null when they all passed.
  const [checks, setChecks] = useState<DocumentChecksView | null>(null);

  function showStarter(next: DocumentDraft) {
    setDraft(next);
    setSourceCheck(null);
    setChecks(null);
  }

  function landDraft(next: DocumentDraft, nextChecks: DocumentChecksView | null) {
    setDraft(next);
    setSourceCheck(null);
    setChecks(nextChecks);
    setLanded((count) => count + 1);
  }

  useEffect(
    () =>
      subscribeModeHandoff("documents", (handoff) => {
        setSourceText(handoff.sourceText);
        setSourceTitle(handoff.title ?? null);
        setPrompt(handoff.prompt);
        setError(null);
      }),
    [],
  );

  async function onGenerate(event: FormEvent) {
    event.preventDefault();
    const topic = prompt.trim();
    if (!topic || busy || needsKey) {
      return;
    }
    setBusy("generate");
    setError(null);
    try {
      const res = await apiFetch("/api/v1/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: topic,
          // Only a deliberate pick travels as pinned: a seeded default stays rescuable by the host's fallback.
          ...modelPickBody(studioModelPick(model, modelPinned)),
          sourceText: sourceText.trim() || undefined,
          ...sourceFilesBody(deskSources),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(errorMessage(data, t("documents.errors.generate")));
      }
      const landed = splitDraftResponse(data);
      landDraft(landed.draft, landed.checks);
    } catch (err) {
      setDraft(null);
      setChecks(null);
      setError(err instanceof Error ? err.message : t("documents.errors.generate"));
    } finally {
      setBusy(null);
    }
  }

  async function onRegenerate(index: number, payload: JobRegenSubmit) {
    if (!draft || busy) {
      return;
    }
    setBusy("regen");
    setRegenIndex(index);
    setError(null);
    try {
      const res = await apiFetch("/api/v1/documents/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft,
          sectionIndex: index,
          prompt,
          instruction: payload.instruction || undefined,
          ...modelPickBody(regenModelPick(payload.model, model, modelPinned)),
          attachments: payload.attachments.length > 0 ? payload.attachments : undefined,
          sourceText: sourceText.trim() || undefined,
          ...sourceFilesBody(deskSources),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(errorMessage(data, t("documents.errors.regen")));
      }
      setDraft(data as DocumentDraft);
      // The flags named sections of the draft that was just changed.
      setChecks(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("documents.errors.regen"));
    } finally {
      setBusy(null);
      setRegenIndex(null);
    }
  }

  async function onDownload() {
    if (!draft || busy) {
      return;
    }
    setBusy("download");
    setError(null);
    try {
      const res = await apiFetch("/api/v1/documents/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(errorMessage(data, t("documents.errors.docx")));
      }
      if (isElectron()) {
        // apiFetch already wrote the bytes through the native save dialog; a second, browser-style
        // download here would open the save dialog twice.
        return;
      }
      const blob = await res.blob();
      const filename = filenameFromDisposition(res.headers.get("Content-Disposition")) ?? "document.docx";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("documents.errors.docx"));
    } finally {
      setBusy(null);
    }
  }

  async function onCheck() {
    if (!draft || busy) {
      return;
    }
    setBusy("check");
    setError(null);
    setSourceCheck(null);
    try {
      const res = await apiFetch("/api/v1/documents/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft, sourceText, ...sourceFilesBody(deskSources) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(errorMessage(data, t("documents.checkError")));
      }
      setSourceCheck(
        data as { checked: boolean; reason?: string; items: Array<{ sentence: string; supported: boolean }> },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("documents.checkError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main
      data-mode="documents"
      className="flex min-h-full w-full flex-col px-6 py-4 text-[var(--text)]"
      data-testid="documents-studio"
    >
      <ModeHeader
        icon="documents"
        title={t("documents.title")}
        outcome={t("documents.expectedInputs")}
        actions={
          draft ? (
            <>
              <button
                type="button"
                onClick={() => void onCheck()}
                disabled={busy !== null}
                className="btn btn-ghost rounded-pill px-4"
                data-testid="documents-check"
              >
                {busy === "check" ? t("documents.checking") : t("documents.check")}
              </button>
              <button
                type="button"
                onClick={() => void onDownload()}
                disabled={busy !== null}
                className="btn btn-primary rounded-pill px-4"
                data-testid="documents-download"
              >
                {busy === "download" ? <WorkingStatus label={t("documents.building")} /> : t("documents.download")}
              </button>
            </>
          ) : null
        }
      />

      {error && !isGatewayBlockedText(error) ? (
        <div
          className="mt-6 rounded-lg border border-[var(--line)] px-4 py-3 text-sm text-[var(--danger)]"
          role="alert"
          data-testid="documents-error"
        >
          {needsSettingsHint(error)}
          {/gateway|api key|settings|runtime_stub|live gateway/i.test(error) && !/settings/i.test(error) ? (
            <>
              {" "}
              {t("documents.openSettingsLead")}{" "}
              <Link href="/settings" className="underline">
                {t("documents.settings")}
              </Link>
              .
            </>
          ) : null}
        </div>
      ) : null}

      {sourceCheck ? (
        <div
          className="mt-6 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3"
          data-testid="documents-source-check"
        >
          {sourceCheck.checked ? (
            <ul className="space-y-2 text-sm">
              {sourceCheck.items.map((item) => (
                <li
                  key={item.sentence}
                  data-testid={item.supported ? "documents-source-supported" : "documents-source-unsupported"}
                >
                  <span className="font-medium">
                    {item.supported ? t("documents.sourceCheck.supported") : t("documents.sourceCheck.unsupported")}
                  </span>
                  {": "}
                  {item.sentence}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--text-2)]" data-testid="documents-source-check-empty">
              {t("documents.sourceCheck.empty")}
            </p>
          )}
        </div>
      ) : null}

      {draft ? <DocumentChecksNote note={checksNote(checks, draft.sections)} /> : null}

      <ExampleGallery mode="documents" onSelect={(entry) => setPrompt(entry.prompt)} />

      {draft ? null : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {documentStarters().map((starter) => (
            <button
              key={starter.id}
              type="button"
              className="wash rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-left hover:bg-[var(--accent-soft)]"
              onClick={() => {
                showStarter(starter.draft);
                setError(null);
              }}
              data-testid="documents-starter"
            >
              <p className="text-sm font-medium text-[var(--text)]">{starter.label}</p>
              <p className="mt-1 text-xs text-[var(--text-2)]">{starter.description}</p>
            </button>
          ))}
        </div>
      )}

      <form
        className="mt-6 space-y-2 rounded-xl border border-[var(--line)] bg-transparent p-3"
        onSubmit={(event) => void onGenerate(event)}
        // A file made in Chat since this pane mounted shows up the next time the form is used.
        onFocusCapture={() => setDeskRefresh((count) => count + 1)}
        data-testid="documents-studio-prompt-bar"
      >
        <SourceMaterialField
          value={sourceText}
          onChange={setSourceText}
          title={sourceTitle}
          onTitle={setSourceTitle}
          disabled={busy !== null}
          testIdPrefix="documents"
        />
        <DeskSourcePicker
          selected={deskSources}
          onChange={setDeskSources}
          disabled={busy !== null}
          pastedChars={sourceText.length}
          refreshKey={deskRefresh}
        />
        <ModelSelect
          models={models}
          value={model}
          onChange={setModel}
          disabled={busy !== null || models.length === 0}
          testId="documents-studio-model"
          className="select-field w-full"
        />
        <div className={PROMPT_ROW}>
          <EnhancePromptButton
            text={prompt}
            surface="documents"
            model={model}
            disabled={busy !== null}
            testId="documents-enhance"
            onApply={setPrompt}
          />
          <input
            type="text"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className={PROMPT_INPUT}
            placeholder={t("documents.placeholder")}
            disabled={busy !== null}
            data-testid="documents-prompt"
            aria-label={t("documents.topicAria")}
          />
          {busy === "generate" ? (
            <MascotSlot mode="documents" placement="beside" busy phase="drafting" decorative />
          ) : null}
          <button
            type="submit"
            className={`${PROMPT_SUBMIT} ${
              needsKey
                ? "inline-flex h-8 shrink-0 items-center justify-center rounded-pill bg-[var(--line)] px-4 text-sm text-[var(--text-3)]"
                : "wash inline-flex h-8 shrink-0 items-center justify-center rounded-pill bg-[var(--accent)] px-4 text-sm font-medium text-[var(--surface)] disabled:opacity-45"
            }`}
            disabled={busy !== null || !prompt.trim() || needsKey}
            title={needsKey ? t("documents.needsKeyQuiet") : undefined}
            data-testid="documents-generate"
          >
            {busy === "generate" ? <WorkingStatus label={t("documents.generating")} /> : t("documents.generate")}
          </button>
          {keyBlocked ? (
            <NeedsKeyNote testId="documents-needs-key" />
          ) : needsKey ? (
            <p className="basis-full text-xs text-[var(--text-3)]" data-testid="documents-needs-key">
              {t("documents.needsKeyQuiet")}
            </p>
          ) : null}
        </div>
      </form>

      {draft || busy !== null ? null : <StudioEmptyDesk mode="documents" />}

      {draft ? (
        <div className="relative mt-8">
          {landed > 0 ? <Confetti key={landed} /> : null}
          <DocumentPreview
            draft={draft}
            models={models}
            defaultModel={model}
            regeneratingIndex={regenIndex}
            onRegenerate={(index, payload) => void onRegenerate(index, payload)}
          />
        </div>
      ) : null}
    </main>
  );
}
