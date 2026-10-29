"use client";

import type { ReactNode } from "react";
import { isRenderableImageUrl, isRenderableVideoUrl } from "@/lib/composer-attach";
import { mediaSrc } from "@/lib/api-client";
import { FormattedText } from "@/components/formatted-text";
import { MessageEmbed } from "@/components/message-embed";
import { NultronMascot } from "@/components/nultron/nultron-mascot";
import { BUDDY_PRIORITY } from "@/lib/desk-buddy-state";
import { useBuddyTakesStatus } from "@/lib/desk-buddy-store";
import { LETS_GO_MS, LIVE_TURN_NEXT, liveTurnMascot } from "@/lib/mascot-triggers";
import { useBuddyClaim } from "@/lib/use-buddy-claim";
import { useHoldOnMount } from "@/lib/use-hold-on-mount";
import { fileCardDetail, jobEmbedsFromTools } from "@/lib/message-embeds";
import { collectToolMediaParts } from "@/lib/tool-media";
import { DeckCards } from "@/components/chat-deck-card";
import { DelegateCards } from "@/components/chat-delegate-card";
import { DossierCards } from "@/components/chat-dossier-card";
import { FinanceCards } from "@/components/chat-finance-card";
import { MediaPermissionCards } from "@/components/chat-media-permission-card";
import "@/components/chat-turn-bubbles.css";
import { ToolRowBody, isRichTool } from "@/components/tool-rows/tool-row";
import { showsToolSpinner, toolActivityLabel, toolCallSummary } from "@/lib/tool-labels";
import type { ContentPart, ToolCallPart } from "@agentforge/core/content";
import { splitUserFileBlocks } from "@agentforge/core/chat-documents";
import { getLocale, t } from "@/lib/i18n";
import { continuePrompt, stepLimitToolsOf } from "@/lib/chat-continue";
import { permissionRequestsOf } from "@/lib/media-permission";
import type { MediaRequest } from "@agentforge/core/media-permission";
import { SHELL_LAYOUT } from "@agentforge/core/product-modes";

export type LiveTool = {
  key: string;
  status: "started" | "completed";
  input?: unknown;
  output?: unknown;
  /** The latest progress line of a started tool (a worker's phase), drawn in its live row. */
  progress?: string;
};

type Props = {
  role: string;
  content?: unknown;
  live?: {
    thinking: string;
    tools: LiveTool[];
    streaming: string;
    running: boolean;
    thinkingEnabled?: boolean;
    failed?: boolean;
    /** The thread has no assistant reply yet: this is the first turn of a new chat. */
    firstTurn?: boolean;
  };
  /** Sends the word the step-limit sentence asks for. Absent, Continue is shown disabled. */
  onContinue?: (text: string) => void;
  /** A run is already in flight, so Continue waits. */
  continueDisabled?: boolean;
  /** Sends the requests the person pressed Run on. Absent once the turn was followed up: the card then only records them. */
  onRunMedia?: (requests: MediaRequest[]) => void;
};

function PulseDots() {
  return (
    <span className="pulse-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function ChatTurn({ role, content, live, onContinue, continueDisabled = false, onRunMedia }: Props) {
  const isUser = role === "user";
  // A new chat's first turn opens with the lets-go clip, then the working state takes over.
  const launching = useHoldOnMount(Boolean(live?.firstTurn), LETS_GO_MS);
  // The desk buddy is the status character when it is on screen: the live turn tells it what the reply is
  // doing and draws no second Nultron. Without one (no rail, a collapsed rail, another full body on
  // screen) the chip beside the turn is drawn as before. A failure is a flash, set by the session.
  const takesStatus = useBuddyTakesStatus();
  const liveState = live
    ? liveTurnMascot({ failed: live.failed, streaming: Boolean(live.streaming), launching })
    : null;
  useBuddyClaim(
    live && !live.failed && liveState
      ? { state: liveState, busy: Boolean(live.running), priority: BUDDY_PRIORITY.job }
      : null,
  );
  const thinking = live ? live.thinking : thinkingFromContent(content);
  const tools = live ? live.tools : toolsFromContent(content);
  const visibleTools = tools.filter((tool) => tool.status === "started" || tool.status === "completed");
  const liveMedia = live ? live.tools.flatMap((tool) => collectToolMediaParts(tool.output)) : [];
  const thinkingEnabled = live?.thinkingEnabled !== false;
  const showThinkingPlaceholder =
    Boolean(live?.running) && thinkingEnabled && !thinking && !live?.streaming && visibleTools.length === 0;
  /*
   * Thinking and the tool calls are one block now (owner ruling 2026-09-23): the tool rows used
   * to sit above the answer as their own list, so a finished turn showed the machinery before the
   * prose. They belong to the work, not to the result. The disclosure opens itself while the turn
   * is live and collapses when it lands, which is the "curious user can still open it" shape.
   *
   * `hasActivity` also covers a tool with no thinking at all — a stub run with thinking off fires
   * tools without emitting reasoning, and folding on `thinking` alone would have hidden them.
   */
  const hasActivity = Boolean(thinking) || visibleTools.length > 0;
  const showDisclosure = hasActivity || showThinkingPlaceholder;
  const jobs = jobEmbedsFromTools(visibleTools);
  // The host's step_limit part, not the sentence. A live bubble has not been saved yet, so it has no mark.
  const stepLimitTools = !isUser && !live ? stepLimitToolsOf(content) : null;

  return (
    <article
      className={isUser ? "enter-rise chat-turn--user" : "enter-rise chat-turn--assistant"}
      data-testid="message"
    >
      {isUser ? (
        <MessageBody content={content} />
      ) : (
        <div className={live ? "flex items-start gap-3" : "space-y-2"}>
          {/* Tester code: in the chat-first shell no character is drawn inside a thread (owner,
              2026-10-09: the character must not overlap generated content). The head in the rail is
              the status character there; it reads the same claim made above. */}
          {live && liveState && !takesStatus && SHELL_LAYOUT !== "chat-first" ? (
            <NultronMascot state={liveState} busy={Boolean(live.running)} decorative next={LIVE_TURN_NEXT} />
          ) : null}
          <div className="min-w-0 flex-1 space-y-2">
            {showDisclosure ? (
              <details
                className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 shadow-elev-1"
                data-testid="message-thinking"
                open={Boolean(live)}
              >
                <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-[var(--text-3)]">
                  {t("chat.turn.thinking")}
                  {live?.running && thinking ? <PulseDots /> : null}
                </summary>
                {thinking ? (
                  /* Markdown, not a raw `<pre>`: reasoning arrives with lists, emphasis and fenced
                   code, and the block should embed them the way a message does. */
                  <div className="mt-2 max-h-72 overflow-auto" data-testid="thinking-text">
                    <FormattedText text={thinking} className="text-xs" />
                  </div>
                ) : (
                  <p
                    className="mt-2 flex items-center gap-2 text-xs text-[var(--text-2)]"
                    data-testid="thinking-placeholder"
                  >
                    {live?.running ? <PulseDots /> : null}
                    {t("chat.turn.thinkingPlaceholder")}
                  </p>
                )}
                {visibleTools.length > 0 ? (
                  <ul className="mt-2 space-y-1" data-testid="message-tools">
                    {visibleTools.map((tool, index) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
                        key={`${tool.key}-${index}`}
                        className="whitespace-pre-wrap break-words rounded-xl border border-[var(--line)] px-3 py-1.5 font-mono text-xs text-[var(--text-2)]"
                        data-testid="message-tool"
                        data-tool={tool.key}
                      >
                        {tool.status === "started" && tool.progress ? (
                          <span className="flex items-center gap-2" data-testid="message-tool-progress">
                            {tool.progress}
                            <PulseDots />
                          </span>
                        ) : isRichTool(tool.key) ? (
                          <ToolRowBody tool={tool} />
                        ) : tool.status === "started" && showsToolSpinner(tool.key) ? (
                          toolActivityLabel(tool.key, tool.input)
                        ) : (
                          toolCallSummary(tool.key, tool.input, tool.output)
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            ) : null}
            {live?.streaming ? (
              <div className="space-y-2">
                <div className="chat-turn-bubble">
                  <FormattedText text={live.streaming} className="text-sm" testId="message-output" />
                </div>
                {live.running && !showDisclosure ? <PulseDots /> : null}
              </div>
            ) : (
              <>
                <MessageBody content={content} outputOnly />
                {stepLimitTools && onContinue ? (
                  <button
                    type="button"
                    className="btn"
                    data-testid="chat-continue"
                    disabled={continueDisabled}
                    onClick={() => onContinue?.(continuePrompt(getLocale()))}
                  >
                    {t("chat.turn.continue")}
                  </button>
                ) : null}
                {live?.running && !showDisclosure ? <PulseDots /> : null}
              </>
            )}
            {liveMedia.length > 0 ? <MediaParts parts={liveMedia} /> : null}
            <DeckCards tools={visibleTools} />
            <DossierCards tools={visibleTools} />
            <FinanceCards tools={visibleTools} />
            <MediaPermissionCards
              requests={permissionRequestsOf(visibleTools)}
              disabled={continueDisabled}
              {...(onRunMedia ? { onRun: onRunMedia } : {})}
            />
            <DelegateCards tools={visibleTools} />
            {jobs.map((job, index) => (
              <MessageEmbed
                // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
                key={`${job.title}-${index}`}
                kind="job"
                title={job.title}
                detail={job.detail}
                href={job.href}
              />
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export function messageHasDisplayableContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return content != null;
  }
  return content.some((part) => {
    if (!part || typeof part !== "object") {
      return false;
    }
    const type = (part as { type?: unknown }).type;
    if (type === "thinking") {
      return String((part as { text?: unknown }).text ?? "").trim().length > 0;
    }
    if (type === "tool_call" || type === "step_limit") {
      return true;
    }
    if (type === "text") {
      return String((part as { text?: unknown }).text ?? "").trim().length > 0;
    }
    return partImageUrl(part) != null || partVideoUrl(part) != null;
  });
}

function thinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "thinking")
    .map((part) => String((part as { text: string }).text ?? ""))
    .join("")
    .trim();
}

function toolsFromContent(content: unknown): LiveTool[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((part): part is ToolCallPart =>
      Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "tool_call"),
    )
    .map((part) => ({
      key: part.toolKey,
      status: part.status,
      input: part.input,
      output: part.output,
    }));
}

function MessageBody({ content, outputOnly = false }: { content?: unknown; outputOnly?: boolean }) {
  if (typeof content === "string") {
    if (outputOnly && !content.trim()) {
      return null;
    }
    return outputOnly ? (
      <div className="chat-turn-bubble">
        <FormattedText text={content} className="text-sm" testId="message-output" />
      </div>
    ) : (
      <UserPlain text={content} />
    );
  }
  if (!Array.isArray(content)) {
    if (content == null) {
      return null;
    }
    return <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{JSON.stringify(content)}</p>;
  }

  const parts = outputOnly
    ? content.filter((part) => {
        if (!part || typeof part !== "object") return false;
        const type = (part as { type?: unknown }).type;
        return type === "text" || type === "image_url" || type === "video_url";
      })
    : content;

  if (outputOnly) {
    return <AnswerParts parts={parts} />;
  }

  return (
    <div className="space-y-2">
      {parts.map((part, index) => {
        const imageUrl = partImageUrl(part);
        if (imageUrl) {
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          return <MessageEmbed key={index} kind="image" title="" src={imageUrl} alt="" />;
        }
        const videoUrl = partVideoUrl(part);
        if (videoUrl) {
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          return <MessageEmbed key={index} kind="video" title="" src={videoUrl} />;
        }
        if (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && "text" in part) {
          const text = String((part as { text: string }).text);
          if (!text.trim()) return null;
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          return <UserPlain key={index} text={text} />;
        }
        return null;
      })}
    </div>
  );
}

/**
 * The agent's saved answer: runs of text sit in one soft bubble, and a picture or video between them
 * stays outside it, at the bubble's left edge, in the order the model wrote them.
 */
function AnswerParts({ parts }: { parts: unknown[] }) {
  const nodes: ReactNode[] = [];
  let run: string[] = [];
  const flush = (key: number) => {
    if (run.length === 0) return;
    nodes.push(
      <div key={`text-${key}`} className="chat-turn-bubble">
        {run.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          <FormattedText key={index} text={text} className="text-sm" testId="message-output" />
        ))}
      </div>,
    );
    run = [];
  };
  parts.forEach((part, index) => {
    const imageUrl = partImageUrl(part);
    const videoUrl = imageUrl ? null : partVideoUrl(part);
    if (imageUrl || videoUrl) {
      flush(index);
      nodes.push(
        imageUrl ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          <MessageEmbed key={index} kind="image" title="" src={imageUrl} alt="" />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          <MessageEmbed key={index} kind="video" title="" src={videoUrl ?? undefined} />
        ),
      );
      return;
    }
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && "text" in part) {
      const text = String((part as { text: string }).text);
      if (text.trim()) run.push(text);
    }
  });
  flush(parts.length);
  return <div className="space-y-2">{nodes}</div>;
}

function MediaParts({ parts }: { parts: ContentPart[] }) {
  return (
    <div className="space-y-2">
      {parts.map((part, index) => {
        const imageUrl = partImageUrl(part);
        if (imageUrl) {
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          return <MessageEmbed key={index} kind="image" title="" src={imageUrl} alt="" />;
        }
        const videoUrl = partVideoUrl(part);
        if (videoUrl) {
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          return <MessageEmbed key={index} kind="video" title="" src={videoUrl} />;
        }
        return null;
      })}
    </div>
  );
}

function UserPlain({ text }: { text: string }) {
  const segments = splitUserFileBlocks(text);
  if (segments.length === 1 && segments[0]?.type === "text") {
    // `anywhere`: a pasted URL or blob has no space to break at and ran out of the bubble (a
    // 120-character link measured 1201px of scroll in a 136px bubble at 320px).
    return <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{segments[0].text}</p>;
  }
  return (
    <div className="space-y-2">
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
          <p key={index} className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
            {segment.text}
          </p>
        ) : (
          <MessageEmbed
            // biome-ignore lint/suspicious/noArrayIndexKey: parts and runs have no id and only grow while a turn streams, so the position is the identity
            key={index}
            kind="file"
            title={segment.name}
            detail={fileCardDetail(segment.notes)}
            body={segment.body}
          />
        ),
      )}
    </div>
  );
}

function partImageUrl(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as { type?: unknown; image_url?: { url?: unknown } };
  if (record.type !== "image_url") return null;
  const url = record.image_url?.url;
  return typeof url === "string" && isRenderableImageUrl(url) ? mediaSrc(url) : null;
}

function partVideoUrl(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as { type?: unknown; video_url?: { url?: unknown } };
  if (record.type !== "video_url") return null;
  const url = record.video_url?.url;
  return typeof url === "string" && isRenderableVideoUrl(url) ? mediaSrc(url) : null;
}
