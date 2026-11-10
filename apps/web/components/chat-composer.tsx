"use client";

import { useEffect, useRef, useState } from "react";
import { consumeSse } from "@/lib/sse-client";
import {
  COMPOSER_FILE_ACCEPT,
  attachmentOverCap,
  classifyAttachment,
  pastedFiles,
  routeDecision,
  type AttachmentKind,
} from "@/lib/composer-attach";
import { TierPicker } from "@/components/tier-picker";
import { CHAT_DOCUMENTS_PER_MESSAGE } from "@agentforge/core/chat-documents";
import type { MediaRequest } from "@agentforge/core/media-permission";
import { ComposerAttachmentChip } from "@/components/composer-attachment-chip";
import {
  ChatDocumentError,
  documentErrorMessage,
  documentsBlockSend,
  documentsOverLimit,
  inlineBlock,
  restoreDocumentRead,
  type DocumentRead,
} from "@/lib/composer-documents";
import { useChipOriginals } from "@/lib/use-chip-originals";
import { useDocumentReads } from "@/lib/use-document-reads";
import { EnhancePromptButton } from "@/components/enhance-prompt-button";
import { ComposerPlusMenu } from "@/components/composer-plus-menu";
import { type ComposerVoice, VoiceMicButton } from "@/components/voice/voice-mic-button";
import { apiFetch } from "@/lib/api-client";
import { abortErrorMessage, armStreamWatchdog } from "@agentforge/core/stream-watchdog";
import { DEFAULT_MODEL_TIER, type ModelTierId } from "@agentforge/core/tiers";
import { buildChatRunBody, tierErrorMessage } from "@/lib/chat-tier-body";
import { tierStreamLimits, type ChatTierInfo } from "@/lib/chat-tier-pref";
import { submitOnEnter } from "@/lib/composer-enter";
import { sendSource } from "@/lib/chat-continue";
import { getLocale, t } from "@/lib/i18n";
import { readComposerDraft, writeComposerDraft } from "@/lib/composer-draft";
import { startRun } from "@/lib/run-generation";
import { useWorkspaceScope } from "@/lib/workspace-scope";
import { NeedsKeyNote } from "@/components/needs-key-note";
import { ComposerAttachmentNotes } from "@/components/composer-attachment-notes";
import type { ModelFallbackNotice } from "@/components/chat-model-fallback-notice";
import { imageRefusalMessage } from "@/lib/composer-image-support";
import { gatewayBlockedMessage, hostedGatewayBlocked } from "@/lib/gateway-blocked";
import { hostedKeyBlock, useDeskNeedsKey } from "@/lib/use-desk-needs-key";
import "@/components/composer-bare.css";

export type ComposerUserSendPayload = { text: string; parts?: unknown[]; retry?: boolean };

type Props = {
  threadId: string | null;
  onEnsureThread?: () => Promise<string>;
  modalities: string[];
  /** The choice a send carries: Daily, Fastest or Reasoning. The host turns it into a model; this never sees one. */
  tier?: ModelTierId;
  /** The three choices as the host reports them, for the picker. */
  tiers?: readonly ChatTierInfo[];
  onTierChange?: (tier: ModelTierId) => void;
  onUserSend?: (payload: ComposerUserSendPayload) => void;
  onStarted?: () => void;
  onDelta: (text: string) => void;
  onThinking?: (text: string) => void;
  onTool?: (event: { phase: "started" | "completed"; toolKey: string; input?: unknown; output?: unknown }) => void;
  onFailed?: (message: string) => void;
  /** The host answered this turn with a stand-in model (`run.model_fallback`). */
  onModelFallback?: (notice: ModelFallbackNotice) => void;
  onProbing?: (info: { attempt: number; attempts: number; message: string }) => void;
  /** A run ended. `showing` is false when the pane had moved to another session by then. */
  onComplete: (run: RunEnd) => Promise<void> | void;
  /** The host reported `run.completed`; the stream itself may still be open. */
  onSettled?: () => void;
  /**
   * The session the pane is showing; the pane changes it when the owner opens another. A run
   * remembers the key it started under, and once the key moves on it draws nothing more — its
   * stream still runs to the end, so the host keeps the reply — and it no longer holds Send.
   */
  sessionKey?: string | number;
  /** A prompt seeded from outside (the empty screen's suggestions). Applied once, then cleared. */
  draft?: string | null;
  onDraftApplied?: () => void;
  /** The message box placeholder. Defaults to the Chat line; an agent passes its own ("Message {name}"). */
  placeholder?: string;
  voice?: ComposerVoice;
  /** A tool the run is driving reported a progress line (the stream's `tool.progress` events that carry a label). */
  onToolProgress?: (event: { toolKey: string; label: string }) => void;
  /**
   * Continue and Try again write their sender here. The call sends the text it is given (the word
   * `continue`, or the turn to send again with `retry`) and leaves the draft in the box alone. A ref,
   * not an effect: StrictMode runs an effect twice.
   */
  continueSendRef?: { current: ((text: string, retry?: boolean, grants?: readonly MediaRequest[]) => void) | null };
};

type HeldFile = {
  id: string;
  file: File;
  kind: AttachmentKind;
  /** A document's read state: the host reads it as soon as it is attached (`use-document-reads`). */
  read?: DocumentRead;
};

async function uploadMedia(file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.set("file", file);
  const uploaded = await apiFetch("/api/v1/media", { method: "POST", body: form }).then((res) => res.json());
  if (uploaded.error) {
    throw new Error(uploaded.error.message ?? t("chat.error.upload"));
  }
  if (typeof uploaded.url !== "string") {
    throw new Error(t("chat.error.upload"));
  }
  return { url: uploaded.url };
}

/** How far the prompt box grows before it scrolls. `.composer-text` carries the same 10rem in CSS. */
const COMPOSER_TEXT_MAX_PX = 160;

/**
 * Fit the prompt box to its content. The height is reset first so the box can shrink; the CSS
 * `min-height` on `.composer-text` (one line wide, two lines when the composer is narrow) still
 * sets the floor, because a minimum beats an inline height.
 */
function growTextArea(el: HTMLTextAreaElement | null) {
  if (!el) {
    return;
  }
  el.style.height = "0px";
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_TEXT_MAX_PX)}px`;
}

/** Where a run's events are drawn. The pane's live callbacks, gated by `readRunStream`. */
export type RunStreamHandlers = {
  readonly onStarted?: () => void;
  readonly onDelta: (text: string) => void;
  readonly onThinking?: (text: string) => void;
  readonly onTool?: (event: {
    phase: "started" | "completed";
    toolKey: string;
    input?: unknown;
    output?: unknown;
  }) => void;
  readonly onFailed?: (message: string) => void;
  /** A tool the run is driving said what it is doing (`tool.progress` with a phase, step or round label). */
  readonly onToolProgress?: (event: { toolKey: string; label: string }) => void;
  /** The host answered with a stand-in model (`run.model_fallback`): the model asked for, and the one that answered. */
  readonly onModelFallback?: (notice: ModelFallbackNotice) => void;
  /** The host said the run is over (`run.completed`). The stream may stay open a little longer while it saves. */
  readonly onCompleted?: () => void;
};

/** The labelled kinds of job event a tool reports as progress; deltas and sources carry no line to show. */
const PROGRESS_JOB_TYPES = new Set(["job.phase", "job.step", "job.round"]);

/** The line of a `tool.progress` event, or null. Read defensively: the SSE reader passes the payload through untyped. */
function toolProgressLine(event: { type: string; toolKey?: string }): { toolKey: string; label: string } | null {
  const job = (event as { job?: { type?: unknown; label?: unknown } }).job;
  if (event.type !== "tool.progress" || typeof event.toolKey !== "string" || !job) {
    return null;
  }
  if (typeof job.type !== "string" || !PROGRESS_JOB_TYPES.has(job.type)) {
    return null;
  }
  return typeof job.label === "string" && job.label.trim() ? { toolKey: event.toolKey, label: job.label } : null;
}

/** How a run ended, for `onComplete`. */
export type RunEnd = {
  /** The thread the run posted to, or null when it failed before it had one. */
  readonly threadId: string | null;
  /** False when the pane had moved to another session by the time the run ended. */
  readonly showing: boolean;
  /**
   * True when a newer send began before this run's tail ran. The pane must not reset its live state for
   * it (the newer turn owns that); it may still reload the thread if no newer turn is live.
   */
  readonly stale?: boolean;
};

/**
 * Read one run's event stream to the end.
 *
 * Events are drawn through `handlers` while `showing()` says the session the run started in is
 * still on screen. Once it is not — the owner opened another session from the rail — the stream is
 * still read to the end, never cancelled: the host aborts a run whose client goes away
 * (`packages/host/src/http-adapter.ts`), and the reply the owner asked for would never be saved.
 * The host keeps it; this only stops drawing it in a conversation it does not belong to.
 * `onActivity` is fed either way, so the stall watchdog stays quiet for a run that is still answering.
 */
export async function readRunStream(
  body: ReadableStream<Uint8Array>,
  handlers: RunStreamHandlers,
  options: { readonly onActivity?: () => void; readonly showing?: () => boolean } = {},
): Promise<void> {
  const showing = options.showing ?? (() => true);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const consumed = consumeSse(buffer);
    buffer = consumed.rest;
    for (const event of consumed.events) {
      options.onActivity?.();
      if (!showing()) {
        continue;
      }
      if (event.type === "run.started" || event.type === "run.probing") {
        handlers.onStarted?.();
      }
      if (event.type === "assistant.delta" && event.text) {
        handlers.onDelta(event.text);
      }
      if (event.type === "assistant.thinking" && event.text) {
        handlers.onThinking?.(event.text);
      }
      if (event.type === "tool.started" && event.toolKey) {
        handlers.onTool?.({ phase: "started", toolKey: event.toolKey, input: event.input });
      }
      if (event.type === "tool.completed" && event.toolKey) {
        handlers.onTool?.({ phase: "completed", toolKey: event.toolKey, output: event.output });
      }
      const progress = toolProgressLine(event);
      if (progress) {
        handlers.onToolProgress?.(progress);
      }
      if (event.type === "run.model_fallback" && event.from && event.to) {
        handlers.onModelFallback?.({ from: event.from, to: event.to, message: event.message ?? "" });
      }
      if (event.type === "run.failed" && event.message) {
        handlers.onFailed?.(event.message);
      }
      if (event.type === "run.completed") {
        handlers.onCompleted?.();
      }
    }
  }
}

export function ChatComposer({
  threadId,
  onEnsureThread,
  modalities,
  tier = DEFAULT_MODEL_TIER,
  tiers,
  onTierChange,
  onUserSend,
  onStarted,
  onDelta,
  onThinking,
  onTool,
  onFailed,
  onModelFallback,
  onComplete,
  onSettled,
  draft,
  onDraftApplied,
  sessionKey,
  placeholder,
  voice,
  onToolProgress,
  continueSendRef,
}: Props) {
  const { id: workspaceId } = useWorkspaceScope();
  // Restored from outside the keep-alive key so a desk-id remount (boot → real id) and a
  // thread being created do not throw away a file that has not been sent.
  const restored = readComposerDraft(workspaceId);
  const [text, setText] = useState(restored.text);
  const [files, setFiles] = useState<HeldFile[]>(
    restored.files
      .filter(
        (item): item is HeldFile =>
          item.kind === "text" || item.kind === "image" || item.kind === "video" || item.kind === "document",
      )
      // A read that was in flight when the pane went away starts again; a finished one is kept.
      .map((item) => ({ ...item, read: restoreDocumentRead(item.read) })),
  );
  const [busy, setBusy] = useState(false);
  const { reportRead, removeChip } = useChipOriginals(files, setFiles, busy);
  const { retry: retryRead } = useDocumentReads(files, reportRead);
  const [enhancing, setEnhancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  /** The session on screen as of this render, read by a run to know whether it still is. */
  const sessionRef = useRef(sessionKey);
  sessionRef.current = sessionKey;
  /** Counts the sends. The host frees Send at `run.completed`, before the stream closes, so a second turn
   * can start while the first turn's tail is still to run; only the newest run's tail may touch the pane. */
  const runGenerationRef = useRef(0);
  const [shownSession, setShownSession] = useState(sessionKey);
  if (shownSession !== sessionKey) {
    // Another session is on screen. Whatever run held Send, and its error, belonged to the last one.
    // The unsent text and files stay: New chat and creating a thread are not a reason to drop them.
    setShownSession(sessionKey);
    setBusy(false);
    setError(null);
  }
  const [shownTier, setShownTier] = useState(tier);
  if (shownTier !== tier) {
    // The sentence under the box may be the refusal written for the tier that was picked ("cannot read
    // images"). Choosing another makes it stale.
    setShownTier(tier);
    setError(null);
  }

  useEffect(() => {
    writeComposerDraft(workspaceId, { text, files });
  }, [workspaceId, text, files]);

  const needsKey = useDeskNeedsKey();
  // Nultron Enterprise: the same fact, but only on the hosted build, where a signed-in tenant may open
  // the desk before adding a key. It gives the note below a Settings link, and keeps the refused
  // send's own sentence from printing next to it. Always false on the Personal app.
  const keyBlocked = hostedKeyBlock(needsKey);
  const showPicker = typeof onTierChange === "function";
  const sendEmpty = !text.trim() && files.length === 0;
  // A document still being read, or one that failed, holds Send: sending now would drop it silently.
  const documentsHoldSend = documentsBlockSend(files);
  const sendDisabled = busy || enhancing || sendEmpty || needsKey || documentsHoldSend;

  useEffect(() => {
    if (draft == null) {
      return;
    }
    setText(draft);
    textAreaRef.current?.focus();
    onDraftApplied?.();
  }, [draft, onDraftApplied]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the trigger that re-grows the textarea; the body reads only the ref
  useEffect(() => {
    growTextArea(textAreaRef.current);
  }, [text]);

  // The placeholder wraps to a different number of lines as the composer's own width changes (a
  // container query, not the viewport), and a wrap that happened after the last keystroke would
  // otherwise stay clipped. Only a change of width re-measures; a change of height is our own doing.
  useEffect(() => {
    const el = textAreaRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) {
        return;
      }
      lastWidth = el.clientWidth;
      growTextArea(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * The one route every attachment takes: the file picker, a drop and a paste all end here, so a
   * document is classified, counted and read the same way whichever door it came through.
   */
  function addFiles(list: ArrayLike<File> | null) {
    if (!list || list.length === 0) {
      return;
    }
    const next: HeldFile[] = [...files];
    let tooBig = false;
    let unsupported = false;
    let tooMany = false;
    for (const file of Array.from(list)) {
      const kind = classifyAttachment(file);
      if (kind === "unsupported") {
        unsupported = true;
        continue;
      }
      // A document over the cap is still attached, as a chip that says so: the reason belongs on the file.
      if (kind !== "document" && attachmentOverCap(kind, file.size)) {
        tooBig = true;
        continue;
      }
      if (kind === "document" && documentsOverLimit(next, 1)) {
        tooMany = true;
        continue;
      }
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        kind,
      });
    }
    setFiles(next);
    if (tooBig) setError(t("chat.error.fileTooLarge"));
    else if (unsupported) setError(t("chat.error.unsupportedFile"));
    else if (tooMany) setError(t("chat.document.tooMany", { n: CHAT_DOCUMENTS_PER_MESSAGE }));
    else setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function send(override?: string, retrying = false, grants: readonly MediaRequest[] = []) {
    // Continue sends only its word (never the draft or the files in the box), does not wait on a document
    // still being read, and does nothing when clicked again while its run is going.
    const { continuing, typed, attached } = sendSource(override, text, files);
    if (needsKey || (continuing && busy)) {
      return;
    }
    if (!continuing && documentsHoldSend) {
      setError(t("chat.document.mustFinish"));
      return;
    }
    // The run belongs to the session on screen now. If the owner opens another before the run
    // reaches the host, nothing is sent and the draft stays in the box; if they open one after, the
    // run streams on to the host — which saves the reply — but writes nothing more into this pane.
    const startedIn = sessionRef.current;
    const showing = () => sessionRef.current === startedIn;
    const isCurrentRun = startRun(runGenerationRef);
    let runThread: string | null = null;
    // A newer turn that began first makes this tail stale: the pane is told, so it leaves that turn's
    // streaming text and tools alone and only reloads this turn's saved reply if no newer turn is live.
    const finish = () =>
      onComplete({ threadId: runThread, showing: showing(), ...(isCurrentRun() ? {} : { stale: true }) });
    const fail = (message: string) => {
      if (showing() && isCurrentRun()) {
        setError(message);
        onFailed?.(message);
      }
    };
    /** Only the draft that was sent is cleared, with its chips; what was typed or attached since is the owner's. */
    const clearSent = () => {
      if (continuing) {
        return;
      }
      setText((current) => (current === typed ? "" : current));
      setFiles((current) => current.filter((item) => !attached.some((sent) => sent.id === item.id)));
    };
    const live: RunStreamHandlers = {
      onStarted,
      onDelta,
      onThinking,
      onTool,
      onToolProgress,
      onFailed: (message) => {
        if (!isCurrentRun()) {
          return;
        }
        onFailed?.(message);
        setError(message);
      },
      onModelFallback: (event) => {
        if (!isCurrentRun()) {
          return;
        }
        onModelFallback?.(event);
      },
      // The answer is whole: free Send and the Thinking card now, not when the connection closes. The host
      // still saves the reply and closes the stream; `finish` reloads the thread when it does.
      onCompleted: () => {
        if (!isCurrentRun()) {
          return;
        }
        setBusy(false);
        onSettled?.();
      },
    };
    setBusy(true);
    setError(null);
    try {
      const decision = routeDecision(attached.map((item) => item.kind));
      if (decision.route === "error") {
        setError(
          decision.message === "Unsupported file type" ? t("chat.error.unsupportedFile") : t("chat.error.mixedMedia"),
        );
        setBusy(false);
        return;
      }

      if (decision.route === "image" && !modalities.includes("image")) {
        setError(imageRefusalMessage(undefined, []));
        setBusy(false);
        return;
      }
      if (decision.route === "video" && !modalities.includes("video")) {
        setError(t("chat.error.noVideoInput"));
        setBusy(false);
        return;
      }

      // Text files and documents are both inlined as a `--- name ---` block, in the order attached, with
      // the host's notes above the header. A document's text was read by the host when it was attached
      // and is saved to the desk now; a text file is read here and cut to the same budget.
      const inlineFiles = attached.filter((item) => item.kind === "text" || item.kind === "document");
      const mediaFiles = attached.filter((item) => item.kind === "image" || item.kind === "video");

      let composedText = typed;
      try {
        for (const held of inlineFiles) {
          const block = await inlineBlock(held);
          if (block === null) {
            continue;
          }
          composedText = composedText.trim().length > 0 ? `${composedText}\n\n${block}` : block;
        }
      } catch (error) {
        if (error instanceof ChatDocumentError) {
          // A document that cannot be saved is a message that does not go: say why, keep the draft.
          if (showing()) {
            setError(documentErrorMessage(error.key));
          }
          return;
        }
        throw error;
      }

      const outgoing = composedText.trim();
      if (decision.route === "text" && !outgoing) {
        if (showing()) {
          setError(t("chat.error.emptySend"));
        }
        return;
      }

      const abort = new AbortController();
      // A stall reads "No first token from Reasoning ...": the tier's label, because the renderer is
      // never told which model answered. The budget is the tier's (`tierStreamLimits`), not a model's.
      const tierLabel = t(`chat.tiers.${tier}.label`);
      const dog = armStreamWatchdog(tierLabel, abort, tierStreamLimits(tier), Date.now, getLocale());
      try {
        if (decision.route === "text") {
          if (!showing()) {
            return; // Moved on before the run reached the host: nothing was sent, the draft stays.
          }
          const id = onEnsureThread ? await onEnsureThread() : threadId;
          if (!id) {
            throw new Error(t("chat.error.start"));
          }
          if (!showing()) {
            return; // Moved on before the run reached the host: nothing was sent, the draft stays.
          }
          runThread = id;
          onUserSend?.({
            text: outgoing,
            parts: outgoing ? [{ type: "text", text: outgoing }] : [],
            retry: retrying,
          });
          const response = await apiFetch(`/api/v1/threads/${id}/runs/text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildChatRunBody(outgoing, tier, retrying, grants)),
            signal: abort.signal,
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            // Hosted only: a 403 gateway_blocked is "no usable key", said calmly, not a failed run. A refused
            // tier (503 tier_unavailable) is said in the catalog's words, never the host's, which can name a model.
            fail(
              hostedGatewayBlocked(payload)
                ? gatewayBlockedMessage()
                : (tierErrorMessage(payload) ?? payload?.error?.message ?? t("chat.error.runFailed")),
            );
            await finish();
            return;
          }
          clearSent();
          if (!response.body) {
            throw new Error(t("chat.error.noStream"));
          }
          await readRunStream(response.body, live, { onActivity: () => dog.touch(), showing });
          await finish();
          return;
        }

        const uploads: { kind: "image" | "video"; url: string }[] = [];
        for (const held of mediaFiles) {
          const uploaded = await uploadMedia(held.file);
          uploads.push({ kind: held.kind as "image" | "video", url: uploaded.url });
        }

        const caption =
          composedText ||
          (decision.route === "image" ? t("chat.composer.imageCaption") : t("chat.composer.videoCaption"));

        const parts: unknown[] =
          decision.route === "image"
            ? [
                { type: "text", text: caption },
                ...uploads.map((item) => ({
                  type: "image_url",
                  image_url: { url: item.url, detail: "high" },
                })),
              ]
            : [
                { type: "text", text: caption },
                ...uploads.map((item) => ({
                  type: "video_url",
                  video_url: { url: item.url },
                })),
              ];

        if (!showing()) {
          return; // Moved on before the run reached the host: nothing was sent, the draft stays.
        }
        onUserSend?.({ text: caption, parts });

        const id = onEnsureThread ? await onEnsureThread() : threadId;
        if (!id) {
          throw new Error(t("chat.error.start"));
        }
        if (!showing()) {
          return; // Moved on before the run reached the host: nothing was sent, the draft stays.
        }
        runThread = id;

        const response = await apiFetch(`/api/v1/threads/${id}/runs/${decision.route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildChatRunBody(parts, tier)),
          signal: abort.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          fail(tierErrorMessage(payload) ?? payload?.error?.message ?? t("chat.error.runFailed"));
          await finish();
          return;
        }
        clearSent();
        if (!response.body) {
          throw new Error(t("chat.error.noStream"));
        }
        await readRunStream(response.body, live, { onActivity: () => dog.touch(), showing });
        await finish();
      } finally {
        dog.close();
      }
    } catch (err) {
      fail(abortErrorMessage(err, getLocale()));
      await finish();
    } finally {
      if (showing() && isCurrentRun()) {
        setBusy(false);
      }
    }
  }

  // The click reads this on the way to `send`. Writing it during render keeps the closure current.
  if (continueSendRef) {
    continueSendRef.current = (text: string, retry = false, grants: readonly MediaRequest[] = []) => {
      void send(text, retry, grants);
    };
  }

  const sendLabel = busy ? t("agents.composer.sending") : t("agents.composer.send");

  return (
    <form
      className={`composer-shell composer-bare shrink-0${busy ? " composer-sending" : ""}`}
      data-testid="composer"
      // The whole bar takes a dropped file and shows the accent ring while one is over it (`composer-bare.css`).
      data-dragover={dragOver ? "true" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      <div className="composer-bare-row" data-testid="composer-dropzone">
        {/*
          Everything the toolbar used to hold lives under the plus: Add files, Enhance and, when the pane
          offers a choice, the tier picker. The rows stay mounted while the menu is closed, so Enhance keeps
          the prompt it can revert.
        */}
        <ComposerPlusMenu disabled={busy} onAddFiles={() => fileInputRef.current?.click()}>
          <EnhancePromptButton
            text={text}
            surface="chat"
            disabled={busy}
            onApply={setText}
            onBusyChange={setEnhancing}
          />
          {showPicker ? (
            <TierPicker
              tiers={tiers ?? []}
              value={tier}
              onChange={onTierChange}
              disabled={busy}
              returnFocusRef={textAreaRef}
            />
          ) : null}
        </ComposerPlusMenu>
        <textarea
          ref={textAreaRef}
          className="composer-text composer-bare-text"
          rows={1}
          placeholder={placeholder ?? t("chat.composer.placeholder")}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onPaste={(event) => {
            // A file pasted on its own (copied in the file manager, a screenshot) is an attachment and
            // takes the same route as the picker and a drop; a paste that carries text is left alone.
            const pasted = pastedFiles(event.clipboardData);
            if (pasted.length > 0) {
              event.preventDefault();
              addFiles(pasted);
            }
          }}
          onKeyDown={(event) => {
            submitOnEnter(event, () => {
              void send();
            });
          }}
          data-testid="composer-text"
        />
        <VoiceMicButton voice={voice} busy={busy} />
        <button
          type="submit"
          className={
            sendDisabled
              ? "composer-send inline-flex shrink-0 items-center justify-center rounded-pill bg-[var(--line)] text-[var(--text-3)]"
              : "composer-send btn btn-primary shrink-0 !rounded-pill"
          }
          disabled={sendDisabled}
          aria-label={sendLabel}
          title={needsKey ? t("chat.composer.needsKey") : sendLabel}
          data-testid="composer-send"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
        {/* The Add files row clicks this. Kept out of the tab order: it is a 1px control with no name. */}
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          accept={COMPOSER_FILE_ACCEPT}
          onChange={(event) => addFiles(event.target.files)}
          data-testid="composer-file"
        />
      </div>
      {/* Chips, the notes on them, the refusal sentence and the needs-key line sit under the bar's row. */}
      <div className="composer-bare-under">
        {files.length > 0 ? (
          <ul className="flex flex-wrap gap-2" data-testid="composer-attachments">
            {files.map((item) => (
              <ComposerAttachmentChip key={item.id} item={item} onRemove={removeChip} onRetry={retryRead} />
            ))}
          </ul>
        ) : null}
        <ComposerAttachmentNotes kinds={files.map((item) => item.kind)} model={undefined} models={[]} />
        {error && !(keyBlocked && error === gatewayBlockedMessage()) ? (
          <p className="text-sm text-[var(--danger)]" data-testid="composer-error" role="alert">
            {error}
          </p>
        ) : null}
        {keyBlocked ? (
          <NeedsKeyNote testId="composer-needs-key" className="composer-needs-key text-xs text-[var(--text-3)]" />
        ) : needsKey ? (
          <p className="composer-needs-key text-xs text-[var(--text-3)]" data-testid="composer-needs-key">
            {t("chat.composer.needsKey")}
          </p>
        ) : null}
      </div>
    </form>
  );
}
