"use client";

import { useEffect, useRef, useState } from "react";
import { MessageEmbed } from "@/components/message-embed";
import { SettingsLinkHint } from "@/components/settings-link-hint";
import { CHIP, ROW_HEAD } from "@/components/tool-rows/parts";
import {
  formatMediaUsd,
  readAutoAllowed,
  readPendingMedia,
  type PendingMedia,
} from "@/components/tool-rows/media-result";
import type { Rec } from "@/components/tool-rows/results";
import { mediaSrc } from "@/lib/api-client";
import { getLocale, t } from "@/lib/i18n";
import { mediaApi, type MediaFailure } from "@/lib/media-approval-client";
import {
  CHECKING,
  checkProposal,
  generateProposal,
  skipProposal,
  startAction,
  unavailable,
  type MediaAction,
  type MediaCardState,
} from "@/lib/media-approval-flow";
import { collectToolMediaParts } from "@/lib/tool-media";

type ToolCall = { readonly key: string; readonly status: string; readonly output?: unknown };

export function MediaApprovalCards({ tools }: { readonly tools: readonly ToolCall[] }) {
  const pending = tools.flatMap((tool) => {
    if (tool.status !== "completed") {
      return [];
    }
    const media = readPendingMedia(tool.key, tool.output);
    return media ? [media] : [];
  });
  if (pending.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-testid="chat-media-approval-cards">
      {pending.map((media) => (
        <MediaApprovalCard key={media.proposalId} pending={media} />
      ))}
    </div>
  );
}

export function AutoAllowedNotes({ tools }: { readonly tools: readonly ToolCall[] }) {
  const auto = tools.some(
    (tool) =>
      tool.status === "completed" &&
      readAutoAllowed(tool.key, tool.output) &&
      collectToolMediaParts(tool.output).length > 0,
  );
  if (!auto) {
    return null;
  }
  return (
    <p className="text-xs text-[var(--text-3)]" data-testid="chat-media-auto-allowed">
      {t("chat.media.autoAllowed")}
    </p>
  );
}

function MediaApprovalCard({ pending }: { readonly pending: PendingMedia }) {
  const [state, setState] = useState<MediaCardState>(CHECKING);
  const inFlight = useRef(false);

  useEffect(() => {
    let current = true;
    void checkProposal(mediaApi, pending.proposalId).then((next) => {
      if (current) {
        setState(next);
      }
    });
    return () => {
      current = false;
    };
  }, [pending.proposalId]);

  function run(action: MediaAction, work: () => Promise<MediaCardState>) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setState(startAction(action));
    void work()
      .catch(() => unavailable())
      .then((next) => {
        inFlight.current = false;
        setState(next);
      });
  }

  return (
    <MediaApprovalCardView
      pending={pending}
      state={state}
      onGenerate={() => run("generate", () => generateProposal(mediaApi, pending.proposalId, pending.kind, false))}
      onAlways={() => run("always", () => generateProposal(mediaApi, pending.proposalId, pending.kind, true))}
      onSkip={() => run("skip", () => skipProposal(mediaApi, pending.proposalId))}
    />
  );
}

export function MediaApprovalCardView({
  pending,
  state,
  onGenerate,
  onAlways,
  onSkip,
}: {
  readonly pending: PendingMedia;
  readonly state: MediaCardState;
  readonly onGenerate: () => void;
  readonly onAlways: () => void;
  readonly onSkip: () => void;
}) {
  const title = pending.kind === "image" ? t("chat.media.askImage") : t("chat.media.askVideo");
  const estimate =
    pending.amountMicros === null
      ? t("chat.media.priceUnknown")
      : t("chat.media.estimate", { usd: formatMediaUsd(pending.amountMicros, getLocale()) });
  const showButtons = state.phase === "checking" || state.phase === "asking" || state.phase === "working";
  const canDecide = state.phase === "asking";
  const busy = (action: MediaAction) => state.action === action;
  const alwaysLabel = pending.kind === "image" ? t("chat.media.alwaysImage") : t("chat.media.alwaysVideo");
  const buttonClass = `${CHIP} cursor-pointer disabled:cursor-wait disabled:opacity-60`;

  return (
    <div
      className="mt-1 min-w-0 rounded-xl border border-[var(--line)] px-3 py-2 text-[var(--text-2)]"
      data-testid="media-approval-card"
      data-kind={pending.kind}
      data-phase={state.phase}
    >
      <div className={ROW_HEAD}>
        <span className="font-medium text-[var(--text)]" data-testid="media-approval-title">
          {title}
        </span>
        <span
          className="min-w-0 max-w-full text-[var(--text-3)] [overflow-wrap:anywhere]"
          data-testid="media-approval-estimate"
        >
          {estimate}
        </span>
      </div>
      {pending.prompt ? (
        <p className="mt-1 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]" data-testid="media-approval-prompt">
          {pending.prompt}
        </p>
      ) : null}
      {showButtons ? (
        <div className={`${ROW_HEAD} mt-2`}>
          <button
            type="button"
            className={buttonClass}
            disabled={!canDecide}
            onClick={onGenerate}
            data-testid="media-approval-generate"
          >
            {busy("generate") ? t("chat.media.working") : t("chat.media.generate")}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!canDecide}
            onClick={onSkip}
            data-testid="media-approval-skip"
          >
            {busy("skip") ? t("chat.media.working") : t("chat.media.skip")}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!canDecide}
            onClick={onAlways}
            data-testid="media-approval-always"
          >
            {busy("always") ? t("chat.media.working") : alwaysLabel}
          </button>
        </div>
      ) : null}
      {state.failure ? <MediaFailureNote failure={state.failure} /> : null}
      {state.phase === "ended" && state.status ? (
        <p
          className="mt-2 text-[var(--text-3)]"
          role="status"
          data-testid="media-approval-status"
          data-status={state.status}
        >
          {t(`chat.media.status.${state.status}`)}
        </p>
      ) : null}
      {state.phase === "readonly" ? (
        <p className="mt-2 text-[var(--text-3)]" role="status" data-testid="media-approval-readonly">
          {t("chat.media.notYours")}
        </p>
      ) : null}
      {state.phase === "result" && state.result ? (
        <div className="mt-2 space-y-2" data-testid="media-approval-result">
          <ResultMedia result={state.result} />
        </div>
      ) : null}
    </div>
  );
}

function failureText(failure: MediaFailure): string {
  if (failure.code === "storage_quota_exceeded") {
    return t("chat.media.quota");
  }
  if (failure.code === "network") {
    return t("chat.media.network");
  }
  return failure.message?.trim() ? failure.message : t("chat.media.failed");
}

function MediaFailureNote({ failure }: { readonly failure: MediaFailure }) {
  if (failure.code === "gateway_blocked") {
    return (
      <p
        className="mt-2 text-[var(--text-2)]"
        role="alert"
        data-testid="media-approval-failure"
        data-reason={failure.code}
      >
        <SettingsLinkHint i18nKey="chat.media.gatewayBlocked" testId="media-approval-settings" />
      </p>
    );
  }
  return (
    <p
      className="mt-2 text-[var(--text-2)]"
      role="alert"
      data-testid="media-approval-failure"
      data-reason={failure.code}
    >
      {failureText(failure)}
    </p>
  );
}

function ResultMedia({ result }: { readonly result: Rec }) {
  return (
    <>
      {collectToolMediaParts(result).map((part) => {
        if (part.type === "image_url") {
          return (
            <MessageEmbed key={part.image_url.url} kind="image" title="" src={mediaSrc(part.image_url.url)} alt="" />
          );
        }
        if (part.type === "video_url") {
          return <MessageEmbed key={part.video_url.url} kind="video" title="" src={mediaSrc(part.video_url.url)} />;
        }
        return null;
      })}
    </>
  );
}
