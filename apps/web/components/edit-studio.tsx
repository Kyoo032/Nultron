"use client";

import { emptyProject, STARTER_PROJECTS, type ApplyableOp, type EditOp, type EditProject } from "@agentforge/core/edit";
import { formatUsd } from "@agentforge/core/gateway";
import { EditAgentPanel } from "@/components/edit-agent-panel";
import { EditEmptyState } from "@/components/edit-empty-state";
import { EditGenerateTab } from "@/components/edit-generate-tab";
import { FfmpegSetupNotice } from "@/components/ffmpeg-setup-notice";
import { ModeHeader } from "@/components/mode-header";
import { MascotSlot } from "@/components/mascot-slot";
import { WorkingStatus } from "@/components/working-status";
import { imageClipAt } from "@/lib/edit-preview-media";
import { EditRecipesPanel } from "@/components/edit-recipes-panel";
import { EditPreview } from "@/components/edit-preview";
import { EditTimeline } from "@/components/edit-timeline";
import { apiFetch } from "@/lib/api-client";
import { useCatalogVersion } from "@/lib/catalog-version";
import { editInterruptedNote } from "@/lib/edit-agent-note";
import { filenameFromDisposition } from "@/lib/download-name";
import { gatewayBlockedMessage, hostedGatewayBlocked, isGatewayBlockedText } from "@/lib/gateway-blocked";
import { isHostedBuild } from "@/lib/hosted-build";
import { useHostedNeedsKey } from "@/lib/use-desk-needs-key";
import {
  activeJobs,
  createEditProject,
  errorMessage,
  fetchEditDoctor,
  type EditDoctor,
  fetchEditProject,
  fetchEditProjects,
  foldApplied,
  isReviewOpen,
  postEditOps,
  readJson,
  timelineEndFrame,
  turnSpendUsd,
  type EditJob,
  type EditProjectRow,
  type OpCard,
  type UnplacedItem,
} from "@/lib/edit-client";
import { consumeSse } from "@/lib/sse-client";
import { isEditShortcutIgnored, isInHiddenPane } from "@/lib/shortcut-target";
import { useEmitLock } from "@/lib/use-emit-lock";
import { useProductBrand } from "@/lib/product-brand";
import { t } from "@/lib/i18n";
import { Link } from "@/lib/nav";
import { useCallback, useEffect, useRef, useState } from "react";

type ToolId = "upload" | "generate" | "ingredients" | "titles" | "captions" | "recipes" | "history";

const TOOLS: { id: ToolId }[] = [
  { id: "upload" },
  { id: "generate" },
  { id: "ingredients" },
  { id: "titles" },
  { id: "captions" },
  { id: "recipes" },
  { id: "history" },
];

type StudioModel = { id: string; label: string; provider?: string; inputModalities: string[]; contextLength?: number };

export function EditStudio() {
  const { gatewayName } = useProductBrand();
  const emitLock = useEmitLock();
  const fileRef = useRef<HTMLInputElement>(null);
  const eventsAbort = useRef<AbortController | null>(null);
  const agentAbort = useRef<AbortController | null>(null);
  const lastAgentSeq = useRef(0);
  const covered = useRef<Set<number>>(new Set());
  const ackSentFor = useRef(-1);

  const [items, setItems] = useState<EditProjectRow[]>([]);
  const [project, setProject] = useState<EditProject | null>(null);
  // The copy the next host frame folds onto. It is moved ahead of the render by `putProject`, so two
  // frames that arrive in one tick (the project stream and the agent turn's stream carry the same
  // ops) are folded one after the other and not both onto the copy the last render drew.
  const projectRef = useRef<EditProject | null>(null);
  projectRef.current = project;
  const [cards, setCards] = useState<OpCard[]>([]);
  const [jobs, setJobs] = useState<EditJob[]>([]);
  const [unplaced, setUnplaced] = useState<UnplacedItem[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const [opsPosted, setOpsPosted] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolId>("upload");
  const [projectName, setProjectName] = useState(() => t("edit.defaultProjectName"));
  const [starterId, setStarterId] = useState(STARTER_PROJECTS[0]?.id ?? "blank-16x9");
  const [tier, setTier] = useState("standard");
  const [hasKey, setHasKey] = useState(true);
  // Nultron Enterprise: a signed-in tenant may open the desk before adding a key (hosted only; false
  // elsewhere). `hasKey` is what two reads said at mount, so on the hosted build the shared gate
  // decides instead, which also hears a key saved in Settings and a refused call.
  const hostedNeedsKey = useHostedNeedsKey();
  const [doctor, setDoctor] = useState<EditDoctor | null>(null);
  const [spendCap, setSpendCap] = useState(2);
  const [models, setModels] = useState<StudioModel[]>([]);
  const [imageModels, setImageModels] = useState<StudioModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composerPrefill, setComposerPrefill] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  // The last agent turn's note, such as a run that stopped after its tools ran. Cleared when the next turn starts.
  const [agentNote, setAgentNote] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const result = await fetchEditProjects();
      if (result.status !== 404) {
        setItems(result.items);
      }
    } catch {
      // host route may still be landing
    }
  }, []);

  const putProject = useCallback((next: EditProject) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  const applyLoaded = useCallback(
    (loaded: { project: EditProject; cards: OpCard[]; jobs: EditJob[]; unplaced: UnplacedItem[]; seq: number }) => {
      putProject(loaded.project);
      setCards((current) => mergeCards(current, loaded.cards));
      setJobs(loaded.jobs);
      setUnplaced(loaded.unplaced.filter((item) => !item.discardedAt && !item.placedClipId));
      setClock(loaded.project.seq);
      lastAgentSeq.current = loaded.project.review.lastAgentSeq;
    },
    [putProject],
  );

  const reloadProject = useCallback(
    async (id: string) => {
      const { loaded } = await fetchEditProject(id);
      if (loaded) {
        applyLoaded(loaded);
      }
    },
    [applyLoaded],
  );

  // The copy fell behind the host (a frame skipped a seq, or an op did not fit): take the host's
  // project instead. Only a reload that fails is the owner's business, and it is said inline; the
  // studio stays up either way.
  const resyncProject = useCallback(
    async (id: string) => {
      try {
        const { loaded } = await fetchEditProject(id);
        if (loaded) {
          applyLoaded(loaded);
          return;
        }
      } catch {
        // fall through to the same message as a refused reload
      }
      setError(t("edit.errors.apply"));
    },
    [applyLoaded],
  );

  // Every frame the host pushes (the project stream's `ops.appended`, the agent turn's `edit.ops`, an
  // import's `op`) goes through here. Applying one inside a state updater is what used to take the
  // studio down: the same op arrives by more than one road, and a throw in an updater is a throw in
  // render.
  const foldFrame = useCallback(
    (ops: EditOp[]) => {
      const current = projectRef.current;
      if (!current) {
        return;
      }
      const folded = foldApplied(current, ops);
      if (folded.project !== current) {
        putProject(folded.project);
      }
      if (folded.diverged) {
        void resyncProject(current.id);
      }
    },
    [putProject, resyncProject],
  );

  useEffect(() => {
    void loadList();
    void fetchEditDoctor().then((report) => {
      if (report) {
        setDoctor(report);
      }
    });
  }, [loadList]);

  const catalogVersion = useCatalogVersion();
  useEffect(() => {
    void catalogVersion;
    let cancelled = false;
    void apiFetch("/api/v1/settings")
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setHasKey(Boolean(payload.hasOpenai));
        if (typeof payload.editTurnCapUsd === "number") {
          setSpendCap(Math.min(50, Math.max(0.5, payload.editTurnCapUsd)));
        }
      })
      .catch(() => undefined);
    void apiFetch("/api/v1/videos")
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (Array.isArray(payload.models)) {
          setModels(payload.models);
        }
        if (payload.ready === false) {
          setHasKey(false);
        }
      })
      .catch(() => undefined);
    void apiFetch("/api/v1/images")
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (Array.isArray(payload.models)) {
          setImageModels(payload.models);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalogVersion]);

  useEffect(() => {
    eventsAbort.current?.abort();
    if (!project?.id) {
      return;
    }
    const abort = new AbortController();
    eventsAbort.current = abort;
    void (async () => {
      try {
        const response = await apiFetch(`/api/v1/edit/projects/${project.id}/events`, { signal: abort.signal });
        if (!response.ok || !response.body) {
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!abort.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          const parsed = consumeSse(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            const type = event.type;
            const record = event as unknown as Record<string, unknown>;
            if (type === "ops.appended" || type === "edit.ops") {
              const ops = (record.ops ?? record.applied) as EditOp[] | undefined;
              if (Array.isArray(ops) && ops.length > 0) {
                foldFrame(ops);
                const last = ops[ops.length - 1];
                if (last) {
                  setParent(last.id);
                  setClock(last.clock);
                }
              }
            }
            if (type === "card.updated" || type === "edit.card") {
              const card = (record.card ?? record) as OpCard;
              if (card && (typeof card.id === "string" || card.verb)) {
                setCards((current) => upsertCard(current, card));
              }
              emitLock.onCard();
            }
            if (type === "job.progress" || type === "job.done" || type === "edit.job") {
              const job = (record.job ?? record) as EditJob;
              if (job && typeof job.id === "string") {
                setJobs((current) => {
                  const rest = current.filter((item) => item.id !== job.id);
                  return [...rest, job];
                });
              }
            }
            if (type === "tool.started") {
              const touching = Array.isArray(record.touching) ? (record.touching as string[]) : undefined;
              const toolKey = typeof record.toolKey === "string" ? record.toolKey : "";
              const jobPending = Boolean(record.jobPending) || /generate_|transcribe|export/.test(toolKey);
              emitLock.onToolStarted(touching, { jobPending });
            }
          }
        }
      } catch {
        // aborted or host not ready
      }
    })();
    return () => abort.abort();
  }, [emitLock, foldFrame, project?.id]);

  async function commitOps(ops: ApplyableOp[]) {
    if (!project) {
      return;
    }
    setError(null);
    try {
      const result = await postEditOps({ project, parent, clock, opsPosted }, ops);
      putProject(result.project);
      setParent(result.parent);
      setClock(result.clock);
      setOpsPosted(result.opsPosted);
      if (result.error) {
        setError(result.error);
        await reloadProject(project.id);
        return;
      }
      if (result.diverged) {
        await resyncProject(project.id);
      }
      for (const cardId of [...new Set(result.keepCardIds)]) {
        await apiFetch(`/api/v1/edit/projects/${project.id}/cards/${cardId}/keep`, { method: "POST" }).catch(
          () => undefined,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("edit.errors.apply"));
    }
  }

  async function onNewProject() {
    const name = projectName.trim() || t("edit.defaultProjectName");
    const created = await createEditProject(name, projectAspectFromStarter(starterId), starterId);
    if (created.error || !created.project) {
      if (created.status === 404) {
        const local = emptyProject({
          id: crypto.randomUUID(),
          workspaceId: "local",
          name,
          aspect: "16:9",
        });
        putProject(local);
        setCards([]);
        setJobs([]);
        setUnplaced([]);
        return;
      }
      setError(created.error ?? t("edit.errors.createProject"));
      return;
    }
    const { loaded } = await fetchEditProject(created.project.id);
    if (loaded) {
      applyLoaded(loaded);
    } else {
      putProject(created.project);
    }
    await loadList();
  }

  async function onImportFile(file: File) {
    if (!project) {
      return;
    }
    const form = new FormData();
    form.set("file", file);
    const response = await apiFetch(`/api/v1/edit/projects/${project.id}/import`, { method: "POST", body: form });
    const payload = await readJson(response);
    if (!response.ok) {
      setError(errorMessage(payload, t("edit.errors.import")));
      return;
    }
    if (payload.op) {
      // The project stream has usually carried this op (and the clip that follows it) already.
      foldFrame([payload.op as EditOp]);
      setOpsPosted((count) => count + 1);
    }
    await reloadProject(project.id);
  }

  function onImportClick() {
    fileRef.current?.click();
  }

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const selectedRef = useRef(selectedClipId);
  selectedRef.current = selectedClipId;
  const commitRef = useRef(commitOps);
  commitRef.current = commitOps;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isInHiddenPane(document.querySelector<HTMLElement>("[data-testid='edit-studio']"))) {
        return;
      }
      // A focused field, select, button or key-taking widget keeps its own keys (Space presses a
      // button, arrows move a select), and a chord such as Ctrl/Cmd+S or +K is never split/play.
      if (isEditShortcutIgnored(event)) {
        return;
      }
      const current = projectRef.current;
      const fps = current?.fps ?? 30;
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        setPlaying((value) => !value);
        return;
      }
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        const clip = current?.clips.find((item) => item.id === selectedRef.current);
        const at = playheadRef.current;
        if (clip && at > clip.timelineStartFrame && at < clip.timelineStartFrame + clip.durationFrames) {
          void commitRef.current([
            { type: "split_clip", payload: { clipId: clip.id, atFrame: at, newClipId: crypto.randomUUID() } },
          ]);
        }
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        const clipId = selectedRef.current;
        if (clipId) {
          void commitRef.current([{ type: "delete_clip", payload: { clipId } }]);
          setSelectedClipId(null);
        }
        return;
      }
      if (event.key === "j" || event.key === "J") {
        setPlaying(false);
        setPlayhead((frame) => Math.max(0, frame - Math.round(fps / 4)));
        return;
      }
      if (event.key === "l" || event.key === "L") {
        setPlaying(false);
        setPlayhead((frame) => frame + Math.round(fps / 4));
        return;
      }
      if (event.key === "k" || event.key === "K") {
        setPlaying((value) => !value);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!project) {
      return;
    }
    if (project.review.lastAgentSeq !== lastAgentSeq.current) {
      lastAgentSeq.current = project.review.lastAgentSeq;
      covered.current = new Set();
      ackSentFor.current = -1;
    }
  }, [project]);

  function onScrubBucket(seconds: number) {
    if (!project) {
      return;
    }
    const endSeconds = timelineEndFrame(project) / project.fps;
    const bucket = Math.floor(seconds);
    covered.current.add(bucket);
    const total = Math.max(1, Math.ceil(endSeconds));
    if (covered.current.size >= total && project.review.lastAgentSeq > project.review.ackSeq) {
      if (ackSentFor.current !== project.review.lastAgentSeq) {
        ackSentFor.current = project.review.lastAgentSeq;
        void commitOps([{ type: "review_ack", payload: { seq: project.review.lastAgentSeq } }]);
      }
    }
  }

  async function sendAgent(text: string) {
    // Hosted with no usable key: every door to the agent (the composer, "Go", a recipe) is already
    // quiet in the UI; this keeps a stale click or a door added later from making the refused call.
    // `hostedNeedsKey` is false off the hosted build, so the Personal app never takes this branch.
    if (!project || hostedNeedsKey) {
      return;
    }
    agentAbort.current?.abort();
    const abort = new AbortController();
    agentAbort.current = abort;
    setAgentNote(null);
    const response = await apiFetch(`/api/v1/edit/projects/${project.id}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, tier }),
      signal: abort.signal,
    });
    if (response.status === 404) {
      setError(t("edit.errors.agentUnavailable"));
      return;
    }
    if (!response.ok || !response.body) {
      const failure = await readJson(response);
      // Hosted only: a 403 gateway_blocked is "no usable key", said calmly, not a failed edit.
      setError(
        hostedGatewayBlocked(failure) ? gatewayBlockedMessage() : errorMessage(failure, t("edit.errors.agentFailed")),
      );
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!abort.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = consumeSse(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        const record = event as unknown as Record<string, unknown>;
        if (event.type === "tool.started") {
          const touching = Array.isArray(record.touching) ? (record.touching as string[]) : undefined;
          const toolKey = typeof record.toolKey === "string" ? record.toolKey : "";
          emitLock.onToolStarted(touching, {
            jobPending: Boolean(record.jobPending) || /generate_|transcribe|export/.test(toolKey),
          });
        }
        if (event.type === "edit.card" || event.type === "card.updated") {
          const card = (record.card ?? record) as OpCard;
          if (card && (typeof card.id === "string" || card.verb)) {
            setCards((current) => upsertCard(current, card));
          }
          emitLock.onCard();
        }
        if (event.type === "edit.ops" || event.type === "ops.appended") {
          const ops = (record.ops ?? record.applied) as EditOp[] | undefined;
          if (Array.isArray(ops)) {
            foldFrame(ops);
          }
        }
        if (event.type === "edit.plan") {
          const card = (record.card ?? record) as OpCard;
          if (card && typeof card.id === "string") {
            setCards((current) => [
              ...current.filter((item) => item.id !== card.id),
              { ...card, toolKey: card.toolKey ?? "propose_plan" },
            ]);
          }
        }
        if (event.type === "run.interrupted") {
          setAgentNote(editInterruptedNote(typeof record.message === "string" ? record.message : ""));
        }
      }
    }
    await reloadProject(project.id);
  }

  async function onKeep(cardId: string) {
    if (!project) {
      return;
    }
    await apiFetch(`/api/v1/edit/projects/${project.id}/cards/${cardId}/keep`, { method: "POST" });
    await reloadProject(project.id);
  }

  async function onUndo(cardId: string) {
    if (!project) {
      return;
    }
    await apiFetch(`/api/v1/edit/projects/${project.id}/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId }),
    });
    await reloadProject(project.id);
  }

  function onTweak(card: OpCard) {
    const args = card.args ?? { tool: card.toolKey, verb: card.verb, object: card.object };
    setComposerPrefill(typeof args === "string" ? args : JSON.stringify(args));
  }

  async function onCancel(jobId: string) {
    if (!project) {
      return;
    }
    await apiFetch(`/api/v1/edit/projects/${project.id}/jobs/${jobId}/cancel`, { method: "POST" });
    await reloadProject(project.id);
  }

  async function onPlanGo(_card: OpCard) {
    await sendAgent("Go");
  }

  async function onReviewOk() {
    if (!project) {
      return;
    }
    await commitOps([{ type: "review_ack", payload: { seq: project.review.lastAgentSeq } }]);
  }

  async function onPlace(id: string) {
    if (!project) {
      return;
    }
    await apiFetch(`/api/v1/edit/projects/${project.id}/unplaced/${id}/place`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: "v1", timelineStartFrame: playhead }),
    });
    await reloadProject(project.id);
  }

  async function onDiscard(id: string) {
    if (!project) {
      return;
    }
    await apiFetch(`/api/v1/edit/projects/${project.id}/unplaced/${id}/discard`, { method: "POST" });
    await reloadProject(project.id);
  }

  async function onExport() {
    if (!project) {
      return;
    }
    setExporting(true);
    setError(null);
    setExportJobId(null);
    const response = await apiFetch(`/api/v1/edit/projects/${project.id}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "h264-1080p" }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      setExporting(false);
      setError(errorMessage(payload, t("edit.errors.exportBlocked")));
      return;
    }
    const jobId =
      typeof payload.id === "string" ? payload.id : typeof payload.jobId === "string" ? payload.jobId : null;
    setExportJobId(jobId);
    if (!jobId) {
      setExporting(false);
    }
  }

  async function onDownloadExport() {
    if (!project || !exportJobId) {
      return;
    }
    setError(null);
    try {
      const response = await apiFetch(`/api/v1/edit/projects/${project.id}/export/${exportJobId}/file`);
      if (!response.ok) {
        setError(errorMessage(await readJson(response), t("edit.errors.exportNotReady")));
        return;
      }
      const blob = await response.blob();
      const filename = filenameFromDisposition(response.headers.get("Content-Disposition")) ?? "export.mp4";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("edit.errors.exportDownload"));
    }
  }

  const reviewOpen = isReviewOpen(project);
  const jobsLive = activeJobs(jobs);
  const spent = turnSpendUsd(cards, jobs);
  const exportJob = exportJobId ? jobs.find((job) => job.id === exportJobId) : undefined;
  const exportReady = exportJob?.status === "succeeded";
  const exportBusy =
    Boolean(exportJobId) && !exportReady && exportJob?.status !== "failed" && exportJob?.status !== "cancelled";

  useEffect(() => {
    if (!exportJobId) {
      return;
    }
    if (exportJob?.status === "succeeded" || exportJob?.status === "failed" || exportJob?.status === "cancelled") {
      setExporting(false);
    }
  }, [exportJob?.status, exportJobId]);

  return (
    <main
      data-mode="edit"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-app text-[var(--text)]"
      data-testid="edit-studio"
    >
      {doctor ? <FfmpegSetupNotice doctor={doctor} onDoctor={setDoctor} /> : null}
      <div className="shrink-0 border-b border-[var(--line)] px-4 py-3">
        <ModeHeader
          icon="edit"
          title={project?.name ?? t("edit.title")}
          outcome={t("edit.expectedInputs")}
          actions={
            <>
              <select
                className="select-field"
                value={tier}
                onChange={(event) => setTier(event.target.value)}
                data-testid="edit-tier"
              >
                <option value="draft">{t("edit.tier.draft")}</option>
                <option value="standard">{t("edit.tier.standard")}</option>
                <option value="cinematic">{t("edit.tier.cinematic")}</option>
              </select>
              <span className="chip" data-testid="edit-jobs">
                {t("edit.jobs", { count: jobsLive.length > 0 ? `~${jobsLive.length}` : "0" })}
              </span>
              <span className="chip">{t("edit.turnMeter", { spent: formatUsd(spent), cap: formatUsd(spendCap) })}</span>
              <button type="button" className="btn btn-ghost px-2 py-1 text-xs" data-testid="edit-parity-check">
                {t("edit.parity")}
              </button>
              <button
                type="button"
                className="btn btn-primary rounded-pill px-4"
                data-testid="edit-export"
                disabled={!project || !reviewOpen || exporting}
                onClick={() => void onExport()}
              >
                {exporting ? <WorkingStatus label={t("edit.export")} /> : t("edit.export")}
              </button>
            </>
          }
        />
      </div>
      {exporting || exportBusy ? (
        <p className="flex items-center gap-2 px-4" data-testid="edit-export-progress">
          <MascotSlot mode="edit" placement="beside" busy decorative />
          <WorkingStatus label={t("edit.exporting")} />
        </p>
      ) : null}
      {exportReady ? (
        <button
          type="button"
          className="px-4 text-left text-xs underline"
          data-testid="edit-export-download"
          onClick={() => void onDownloadExport()}
        >
          {t("edit.downloadExport")}
        </button>
      ) : null}
      {error && !isGatewayBlockedText(error) ? (
        <p className="px-4 py-1 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {!project ? (
        <EditEmptyState
          items={items}
          starterId={starterId}
          projectName={projectName}
          onStarter={setStarterId}
          onProjectName={setProjectName}
          onNewProject={() => void onNewProject()}
          onOpen={(id) => void reloadProject(id)}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <nav className="flex w-[112px] shrink-0 flex-col overflow-y-auto border-r border-[var(--line)] bg-[var(--surface)] py-2">
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="video/*,image/*,audio/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  void onImportFile(file);
                }
              }}
            />
            {TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`mx-1.5 mb-1 rounded-md px-2 py-1.5 text-left text-sm ${
                  tool === item.id
                    ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]"
                    : "hover:bg-[var(--line)]/40"
                }`}
                data-testid={
                  item.id === "upload" ? "edit-import" : item.id === "generate" ? "edit-generate-tab" : undefined
                }
                onClick={() => {
                  if (item.id === "upload") {
                    void onImportClick();
                  }
                  setTool(item.id);
                }}
              >
                {t(`edit.tools.${item.id}`)}
              </button>
            ))}
          </nav>
          {tool !== "upload" ? (
            <aside className="flex min-h-0 w-[260px] min-w-[180px] shrink flex-col overflow-hidden border-r border-[var(--line)] bg-[var(--surface)] min-[1600px]:w-[300px] min-[2400px]:w-[340px]">
              {tool === "generate" ? (
                <EditGenerateTab
                  project={project}
                  playhead={playhead}
                  stillClip={imageClipAt(project, playhead)}
                  models={models}
                  imageModels={imageModels}
                  needsKey={isHostedBuild() ? hostedNeedsKey : !hasKey}
                  gatewayName={gatewayName}
                  tier={tier}
                  onTierChange={setTier}
                  onSubmitted={() => void reloadProject(project.id)}
                  onAgentPrompt={(text) => void sendAgent(text)}
                />
              ) : tool === "recipes" ? (
                <EditRecipesPanel
                  onRun={(recipeId) => void sendAgent(`Run recipe ${recipeId}`)}
                  needsKey={hostedNeedsKey}
                />
              ) : (
                <p className="p-3 text-xs text-[var(--text-3)]">
                  {tool === "captions" ? (
                    <Link href="/settings" className="underline">
                      {t("edit.tools.captions")}
                    </Link>
                  ) : (
                    t("edit.phaseLater", { label: t(`edit.tools.${tool}`) })
                  )}
                </p>
              )}
            </aside>
          ) : null}
          <div className="flex min-h-0 min-w-[200px] flex-1 flex-col overflow-hidden">
            <EditPreview
              project={project}
              playhead={playhead}
              playing={playing}
              onPlayhead={setPlayhead}
              onPlaying={setPlaying}
              onScrubBucket={onScrubBucket}
            />
            <EditTimeline
              project={project}
              playhead={playhead}
              selectedClipId={selectedClipId}
              lockedClipIds={emitLock.lockedClipIds()}
              jobs={jobs}
              onPlayhead={setPlayhead}
              onSelect={setSelectedClipId}
              onMove={(clipId, trackId, timelineStartFrame) => {
                void commitOps([{ type: "move_clip", payload: { clipId, trackId, timelineStartFrame } }]);
              }}
              onTrim={(clipId, inFrame, durationFrames) => {
                void commitOps([{ type: "trim_clip", payload: { clipId, inFrame, durationFrames } }]);
              }}
            />
            <p className="px-3 py-1 text-xs text-[var(--text-3)]" data-testid="edit-ops-count">
              ops {opsPosted}
            </p>
          </div>
          <EditAgentPanel
            project={project}
            cards={cards}
            jobs={jobs}
            unplaced={unplaced}
            spendCap={spendCap}
            emitLockActive={emitLock.isActive()}
            composerPrefill={composerPrefill}
            onComposerPrefill={setComposerPrefill}
            onSend={(text) => void sendAgent(text)}
            onKeep={(id) => void onKeep(id)}
            onUndo={(id) => void onUndo(id)}
            onTweak={onTweak}
            onCancel={(id) => void onCancel(id)}
            onPlanGo={(card) => void onPlanGo(card)}
            onReviewOk={() => void onReviewOk()}
            onPlace={(id) => void onPlace(id)}
            onDiscard={(id) => void onDiscard(id)}
            needsKey={hostedNeedsKey}
            note={agentNote}
          />
        </div>
      )}
    </main>
  );
}

function upsertCard(current: OpCard[], card: OpCard): OpCard[] {
  const id = card.id || crypto.randomUUID();
  const next: OpCard = {
    ...card,
    id,
    verb: card.verb || "Edit",
    object: card.object || "",
    status: card.status || "proposed",
  };
  return [...current.filter((item) => item.id !== id), next];
}

function mergeCards(current: OpCard[], incoming: OpCard[]): OpCard[] {
  if (incoming.length === 0) {
    return current;
  }
  const map = new Map<string, OpCard>();
  for (const card of current) {
    map.set(card.id, card);
  }
  for (const card of incoming) {
    map.set(card.id, card);
  }
  return [...map.values()];
}

function projectAspectFromStarter(starterId: string): "16:9" | "9:16" | "1:1" {
  const starter = STARTER_PROJECTS.find((item) => item.id === starterId);
  return starter?.aspect ?? "16:9";
}
