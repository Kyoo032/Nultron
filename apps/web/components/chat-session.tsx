"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@/lib/nav";
import { AgentChatHeader } from "@/components/agent-chat-controls";
import { AgentChatDetails, contextNearlyFull } from "@/components/agent-chat-details";
import { AgentHome } from "@/components/agent-home";
import { TierPicker } from "@/components/tier-picker";
import { virtualAgentHref, type VirtualAgentInfo } from "@/lib/virtual-agents";
import { BuddyStage } from "@/components/buddy-stage";
import { ChatAccountChip } from "@/components/chat-account-chip";
import { ChatComposer } from "@/components/chat-composer";
import { continuePrompt, mayOfferContinue } from "@/lib/chat-continue";
import type { MediaRequest } from "@agentforge/core/media-permission";
import { canOfferRetry, retryTextOf } from "@/lib/chat-retry";
import { FolderSurface } from "@/components/folder/folder-surface";
import { ChatContextChip } from "@/components/chat-context-chip";
import { ChatHeader } from "@/components/chat-header";
import { ChatGreeting, ChatIdeaChips } from "@/components/chat-greeting";
import { ChatLauncher } from "@/components/chat-launcher";
import {
  ChatModelFallbackNotice,
  type ModelFallbackNotice,
  nextModelFallback,
} from "@/components/chat-model-fallback-notice";
import { ChatUsageChip } from "@/components/chat-usage-chip";
import { estimateContextParts, estimateConversationTokens } from "@/lib/estimate-tokens";
import {
  knowledgeContextPath,
  knowledgeContextWanted,
  lastAssistantId,
  parseContextParts,
} from "@/lib/knowledge-context";
import type { ContextPart } from "@/components/chat-context-chip";
import { ChatTurn, messageHasDisplayableContent, type LiveTool } from "@/components/chat-turn";
import { NultronMascot } from "@/components/nultron/nultron-mascot";
import { useBuddyTakesStatus } from "@/lib/desk-buddy-store";
import { useChatBuddyReactions } from "@/lib/use-chat-buddy-reactions";
import { collectToolMediaParts } from "@/lib/tool-media";
import { notifyThreadsChanged } from "@/lib/threads-events";
import { apiFetch } from "@/lib/api-client";
import { useHostedNeedsKey } from "@/lib/use-desk-needs-key";
import { DEFAULT_MODEL_TIER, type ModelTierId } from "@agentforge/core/tiers";
import {
  initialChatTier,
  pickChatTier,
  readLastChatTier,
  readThreadChatTier,
  readTierCatalog,
  tierThinkingEnabled,
  writeLastChatTier,
  writeThreadChatTier,
  type ChatTierInfo,
} from "@/lib/chat-tier-pref";
import { getLocale, t } from "@/lib/i18n";
import { isPinnedToEnd } from "@/lib/stick-to-bottom";

type Message = { id: string; role: string; content: unknown };

/**
 * The chat-first shell around a session (tester code, `agent-chat-pane.tsx`): which virtual agent
 * this conversation is with. Absent, the session draws as the published Chat does.
 */
export type ChatSessionShell = {
  agent: VirtualAgentInfo;
  /** The agent's name on screen: the product's name for the generalist. */
  name: string;
  /** New chat, Conversations, How it works: the header's own controls. */
  controls?: ReactNode;
  /** The URL names a thread that belongs to another agent: hand it to that agent's address. */
  onForeignThread?: (ownerAgentId: string, threadId: string) => void;
  /** Set when the agent's own harness still runs from its studio: the empty conversation offers it. */
  onOpenStudio?: () => void;
  detailsTarget?: HTMLElement | null;
};

type Props = {
  agentId?: string;
  initialThreadId?: string;
  shell?: ChatSessionShell;
};

/** Nultron's box on the composer's ledge; about half of it shows above the edge. */
const COMPOSER_BUDDY_SIZE = 112;

export function ChatSession({ agentId, initialThreadId, shell }: Props) {
  // Nultron Enterprise: a signed-in tenant may open the desk before adding a key (hosted only; false and
  // request-free elsewhere). The context estimate below embeds the query, so it goes through the gateway.
  const keyMissing = useHostedNeedsKey();
  const router = useRouter();
  const [agentName, setAgentName] = useState(() => t("chat.title"));
  const [isDefaultChat, setIsDefaultChat] = useState(!agentId);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [agentIdReady, setAgentIdReady] = useState<string | null>(agentId ?? null);
  const [agentModalities, setAgentModalities] = useState<string[]>(["text"]);
  /** The three choices as the host reports them, and the one a send carries. The host picks the model. */
  const [tiers, setTiers] = useState<readonly ChatTierInfo[]>([]);
  const [tierId, setTierId] = useState<ModelTierId>(() => initialChatTier(initialThreadId));
  const [defaultTier, setDefaultTier] = useState<ModelTierId>(DEFAULT_MODEL_TIER);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState("");
  const [thinking, setThinking] = useState("");
  const [tools, setTools] = useState<LiveTool[]>([]);
  /**
   * The stand-in model that answered this turn, if one did. Held here, not on the live turn, because the live
   * turn is thrown away when the reply lands; it stays under the reply until the next send or a change of thread.
   */
  const [fallback, setFallback] = useState<ModelFallbackNotice | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A refused send. The sentence lives on `composer-error`; this only holds the error mascot. */
  const [sendFailed, setSendFailed] = useState(false);
  const [retryText, setRetryText] = useState<string | null>(null);
  const [knowledgeParts, setKnowledgeParts] = useState<ContextPart[]>([]);
  /** A prompt picked from the empty screen's suggestions; handed down once, then cleared. */
  const [composerDraft, setComposerDraft] = useState<string | null>(null);
  /** The composer's text send, for Continue and Try again. Null until the composer has rendered. */
  const continueSendRef = useRef<((text: string, retry?: boolean, grants?: readonly MediaRequest[]) => void) | null>(
    null,
  );
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  /** Read inside the load effect, which must not run again because the shell object is a new one. */
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const runningRef = useRef(running);
  runningRef.current = running;
  // The desk buddy cheers when a reply lands and flinches when a send fails; with it on screen the error
  // line below draws no second Nultron.
  const buddyTakesStatus = useBuddyTakesStatus();
  useChatBuddyReactions({ running, failed: sendFailed, error: Boolean(error) });
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  /** Last `initialThreadId` this pane saw, so leaving a thread (rail "+ New chat") empties it. */
  const lastInitialThreadRef = useRef(initialThreadId);
  /**
   * `?thread=<id>` is known synchronously, but `threadIdRef` only fills once
   * `GET /api/v1/threads/:id` resolves. A send inside that window has to land on the thread
   * the URL already names, otherwise `ensureThread` forks a fresh one (rail sessions make
   * this trivially reachable). Cleared whenever the pane is deliberately emptied or the
   * initial load fails, so "+ New chat" and a dead id still fall through to a real create.
   */
  const pendingThreadRef = useRef<string | null>(initialThreadId ?? null);
  /**
   * Which session the pane is showing, bumped the moment the owner opens another — a rail row or
   * "+ New chat" — in the same render that sees the new `?thread`. The composer tags every run with
   * it: a run whose session is no longer on screen keeps streaming to the host, which saves the
   * reply, but draws nothing here. `ensureThread`'s own `router.replace` is not a switch; it moves
   * `seenInitialThreadRef` first.
   */
  const sessionEpochRef = useRef(0);
  const seenInitialThreadRef = useRef(initialThreadId);
  /**
   * `ensureThread` writes the new id into `seenInitialThreadRef` and then `setThreadId`, which
   * re-renders while `?thread` is still the old value. That render must not count as the owner
   * leaving — it used to bump the session, `onComplete` saw `showing: false`, and `running` stayed
   * true, so a second Thinking row never left the list.
   */
  const awaitingUrlThreadRef = useRef<string | null>(null);
  const urlAtEnsureRef = useRef<string | undefined>(initialThreadId);
  const listRef = useRef<HTMLDivElement>(null);
  /** Follow new text only while the reader is already at the end of the thread. */
  const pinRef = useRef(true);

  useLayoutEffect(() => {
    pinRef.current = true;
    // A new chat has nothing to follow; keep the headline at the top of the pane.
    if (!threadId && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [threadId]);

  useLayoutEffect(() => {
    const el = listRef.current;
    const live = messages.length > 0 || Boolean(streaming) || Boolean(thinking) || running || tools.length > 0;
    if (!el || !pinRef.current || !live) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming, thinking, running, tools]);
  if (awaitingUrlThreadRef.current) {
    if (initialThreadId === awaitingUrlThreadRef.current) {
      awaitingUrlThreadRef.current = null;
      seenInitialThreadRef.current = initialThreadId;
    } else if (initialThreadId !== urlAtEnsureRef.current) {
      awaitingUrlThreadRef.current = null;
      seenInitialThreadRef.current = initialThreadId;
      pendingThreadRef.current = initialThreadId ?? null;
      sessionEpochRef.current += 1;
    }
  } else if (seenInitialThreadRef.current !== initialThreadId) {
    seenInitialThreadRef.current = initialThreadId;
    pendingThreadRef.current = initialThreadId ?? null;
    sessionEpochRef.current += 1;
  }
  const sessionKey = sessionEpochRef.current;

  // What the chosen tier can take in and how much it can hold, as the host reports it. Never a model.
  const selectedTier = tiers.find((tier) => tier.id === tierId);
  const modalities = useMemo(() => {
    const tierMods: readonly string[] = selectedTier?.inputModalities ?? ["text"];
    return ["text", "image", "video"].filter(
      (modality) => agentModalities.includes(modality) && tierMods.includes(modality),
    );
  }, [agentModalities, selectedTier]);

  /** Where a thread of this session lives. In the chat-first shell every agent's is under `/chat`. */
  function threadHref(id: string) {
    if (shell) {
      return virtualAgentHref(shell.agent.id, id);
    }
    return `${agentId ? `/agents/${agentId}` : "/chat"}?thread=${id}`;
  }

  function rememberTier(tier: ModelTierId, forThreadId?: string | null) {
    writeLastChatTier(tier);
    const thread = forThreadId ?? threadIdRef.current;
    if (thread) {
      writeThreadChatTier(thread, tier);
    }
  }

  function handleTierChange(next: ModelTierId) {
    setTierId(next);
    rememberTier(next);
  }

  function resetLive() {
    setStreaming("");
    setThinking("");
    setTools([]);
    setFallback(null);
    setRunning(false);
    setSendFailed(false);
    setRetryText(null);
  }

  async function ensureThread() {
    // The loaded thread wins; the URL's thread is the fallback while its GET is still in flight.
    const openThread = threadIdRef.current ?? pendingThreadRef.current;
    if (openThread) {
      return openThread;
    }
    if (!agentIdReady) {
      throw new Error(t("chat.error.loading"));
    }
    const startedIn = sessionEpochRef.current;
    const created = await apiFetch("/api/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agentIdReady }),
    }).then((res) => res.json());
    if (created.error) {
      throw new Error(created.error.message ?? t("chat.error.start"));
    }
    const id = created.thread.id as string;
    rememberTier(tierId, id);
    notifyThreadsChanged();
    if (sessionEpochRef.current !== startedIn) {
      // The owner opened another session while this thread was being created. Leave the pane
      // where they went instead of pulling it back with the `?thread=` below; the composer sees
      // the same switch and sends nothing into the thread.
      return id;
    }
    threadIdRef.current = id;
    pendingThreadRef.current = id;
    urlAtEnsureRef.current = initialThreadId;
    awaitingUrlThreadRef.current = id;
    seenInitialThreadRef.current = id;
    setThreadId(id);
    router.replace(threadHref(id));
    return id;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetLive is redeclared every render and only sets state; adding it would re-run this load on every render
  useEffect(() => {
    // `?thread=<id>` -> `/chat` is the rail asking for a blank pane, not a re-render to ignore.
    const leftThread = lastInitialThreadRef.current !== undefined && initialThreadId === undefined;
    lastInitialThreadRef.current = initialThreadId;
    let cancelled = false;
    void (async () => {
      try {
        setError(null);
        let readyId = agentId ?? null;
        if (agentId) {
          const [agentPayload, caps, modelPayload] = await Promise.all([
            apiFetch(`/api/v1/agents/${agentId}`).then((res) => res.json()),
            apiFetch(`/api/v1/agents/${agentId}/capabilities`).then((res) => res.json()),
            apiFetch("/api/v1/models").then((res) => res.json()),
          ]);
          if (agentPayload.error) {
            throw new Error(agentPayload.error.message ?? t("chat.error.agentMissing"));
          }
          if (cancelled) {
            return;
          }
          setAgentName(agentPayload.agent?.name ?? t("chat.agent"));
          setIsDefaultChat(agentPayload.agent?.slug === "quick-chat");
          // A virtual agent takes what Chat takes, whatever its row was created with; the host holds the
          // same rule for the run. An agent a person built keeps what its own row says.
          setAgentModalities(shellRef.current ? ["text", "image", "video"] : (caps.inputModalities ?? ["text"]));
          const catalog = readTierCatalog(modelPayload);
          setTiers(catalog.tiers);
          setDefaultTier(catalog.defaultTier);
          readyId = agentId;
          setAgentIdReady(agentId);
        } else {
          const home = await apiFetch("/api/v1/chat").then((res) => res.json());
          if (home.error) {
            throw new Error(home.error.message ?? t("chat.error.open"));
          }
          if (cancelled) {
            return;
          }
          setAgentName(home.agent?.name ?? t("chat.title"));
          setIsDefaultChat(true);
          setAgentModalities(home.version?.inputModalities ?? ["text", "image", "video"]);
          const catalog = readTierCatalog(home);
          setTiers(catalog.tiers);
          setDefaultTier(catalog.defaultTier);
          readyId = home.agent.id;
          setAgentIdReady(home.agent.id);
        }

        if (initialThreadId) {
          if (initialThreadId === threadIdRef.current) {
            return;
          }
          const payload = await apiFetch(`/api/v1/threads/${initialThreadId}`).then((res) => res.json());
          if (payload.error) {
            throw new Error(payload.error.message ?? t("chat.error.threadMissing"));
          }
          if (cancelled) {
            return;
          }
          const threadAgentId = payload.thread?.agentId as string | undefined;
          if (shellRef.current && threadAgentId && readyId && threadAgentId !== readyId) {
            // An agent's address only ever shows that agent's threads.
            shellRef.current.onForeignThread?.(threadAgentId, initialThreadId);
            return;
          }
          if (threadAgentId && readyId && threadAgentId !== readyId && !agentId) {
            router.replace(`/agents/${threadAgentId}?thread=${initialThreadId}`);
            return;
          }
          threadIdRef.current = payload.thread.id;
          pendingThreadRef.current = payload.thread.id;
          setThreadId(payload.thread.id);
          setMessages(payload.messages ?? []);
          resetLive();
          return;
        }

        if (threadIdRef.current && !leftThread) {
          return;
        }

        threadIdRef.current = null;
        pendingThreadRef.current = null;
        setThreadId(null);
        setMessages([]);
        resetLive();
      } catch (err) {
        if (!cancelled) {
          // The URL's thread never loaded, so it is not a safe send target any more.
          pendingThreadRef.current = threadIdRef.current;
          setError(err instanceof Error ? err.message : t("chat.error.open"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, initialThreadId, router]);

  useEffect(() => {
    if (tiers.length === 0) {
      return;
    }
    const threadKey = initialThreadId ?? threadId ?? "";
    setTierId((current) =>
      pickChatTier({
        tiers,
        current,
        threadTier: threadKey ? readThreadChatTier(threadKey) : "",
        lastTier: readLastChatTier(),
        defaultTier,
      }),
    );
  }, [tiers, defaultTier, initialThreadId, threadId]);

  /** Reload a thread's messages — unless the pane has moved to another session while they loaded. */
  async function refreshMessages(id: string) {
    const key = sessionEpochRef.current;
    const payload = await apiFetch(`/api/v1/threads/${id}`).then((res) => res.json());
    if (sessionEpochRef.current === key && threadIdRef.current === id) {
      setMessages(payload.messages ?? []);
    }
  }

  const empty = messages.length === 0 && !streaming && !thinking && !running && tools.length === 0;
  const greeting = empty && !error && shell?.agent.generalist === true;
  const hasReply = messages.some((message) => message.role === "assistant");
  const conversationTokens = estimateConversationTokens(messages, [thinking, streaming]);
  const knowledgeTokens = knowledgeParts.reduce((sum, part) => sum + part.tokens, 0);
  const contextTokens = conversationTokens + knowledgeTokens;
  const contextParts = estimateContextParts({ conversation: conversationTokens, knowledge: knowledgeParts });

  const newestReplyId = lastAssistantId(messages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reply is what makes the rows stale, so it re-runs the read without being read by it
  useEffect(() => {
    if (!knowledgeContextWanted({ keyMissing, hasReply, threadId })) {
      // No chip to feed, no thread to describe, or a desk the host would refuse (`403 gateway_blocked`):
      // the chip simply has no sources.
      setKnowledgeParts((current) => (current.length === 0 ? current : []));
      return;
    }
    let cancelled = false;
    // The thread alone, never its last message: a query makes the host embed it through the gateway, a
    // paid call, and the send already paid for the same retrieval once. The host answers from what the
    // thread's last turn was handed (`packages/host/src/knowledge-last-turn.ts`). Asked again only
    // when the newest reply changes, so opening a thread, and each reply, costs one free read.
    void apiFetch(knowledgeContextPath(threadId as string))
      .then((res) => res.json())
      .then((payload) => {
        if (!cancelled) {
          setKnowledgeParts(parseContextParts(payload));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setKnowledgeParts([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [keyMissing, threadId, hasReply, newestReplyId]);

  return (
    <main
      className="flex h-full min-h-0 flex-col"
      data-testid="chat-home"
      data-agent={shell?.agent.id}
      // A mode agent's pane takes its mode's colour, as its studio does. The generalist keeps Chat's.
      data-mode={shell && !shell.agent.generalist ? shell.agent.id : undefined}
    >
      {shell ? (
        <AgentChatHeader
          agent={shell.agent}
          name={shell.name}
          // The tier is beside the name, not on the composer: the composer is only `+` and the box.
          tier={<TierPicker tiers={tiers} value={tierId} onChange={handleTierChange} disabled={running} />}
          chips={
            <>
              {hasReply && contextNearlyFull(contextTokens, selectedTier?.contextLength ?? undefined) ? (
                <ChatContextChip
                  usedTokens={contextTokens}
                  contextLength={selectedTier?.contextLength ?? undefined}
                  parts={contextParts}
                />
              ) : null}
              <ChatAccountChip />
            </>
          }
          controls={shell.controls}
        />
      ) : (
        <ChatHeader title={isDefaultChat ? t("chat.title") : agentName} compact={empty}>
          {hasReply ? (
            <ChatContextChip
              usedTokens={contextTokens}
              contextLength={selectedTier?.contextLength ?? undefined}
              parts={contextParts}
            />
          ) : null}
          {hasReply ? <ChatUsageChip /> : null}
          <ChatAccountChip />
        </ChatHeader>
      )}

      {shell ? (
        <AgentChatDetails
          target={hasReply ? shell.detailsTarget : null}
          usedTokens={contextTokens}
          contextLength={selectedTier?.contextLength ?? undefined}
          parts={contextParts}
        />
      ) : null}

      {error ? (
        <div className="flex w-full items-start gap-3 px-[var(--chat-gutter)]">
          {/* Never in the chat-first shell: there the head in the rail is the one character on screen. */}
          {running || thinking || tools.length > 0 || streaming || buddyTakesStatus || shell ? null : (
            <NultronMascot state="error" decorative />
          )}
          <p className="text-sm text-[var(--danger)]" data-testid="chat-error" role="alert">
            {error}
          </p>
        </div>
      ) : null}

      <div
        key={threadId ?? "empty"}
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (!el) {
            return;
          }
          pinRef.current = isPinnedToEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
        }}
        // `chat-thread-ledge` keeps the composer character's height free at the end of the thread. The
        // chat-first shell draws no character there, so its thread ends with an ordinary gap.
        className={`min-h-0 w-full flex-1 overflow-y-auto overscroll-y-contain px-[var(--chat-gutter)] ${empty ? "" : shell ? "space-y-4 pb-6 pt-4" : "chat-thread-ledge space-y-4 pt-4"}`}
        data-testid="message-list"
      >
        {empty && !error ? (
          shell && !shell.agent.generalist ? (
            <AgentHome agent={shell.agent} name={shell.name} onOpenStudio={shell.onOpenStudio} />
          ) : shell ? (
            <ChatGreeting />
          ) : (
            <ChatLauncher onSuggest={setComposerDraft} />
          )
        ) : null}
        {messages
          .filter((message) => message.role === "user" || messageHasDisplayableContent(message.content))
          .map((message, index, shown) => (
            <ChatTurn
              key={message.id}
              role={message.role}
              content={message.content}
              continueDisabled={running}
              // Only the newest reply may continue: an older step-limit turn was already followed up.
              onContinue={
                agentIdReady && mayOfferContinue(index, shown.length, message.role)
                  ? () => {
                      if (runningRef.current) {
                        return;
                      }
                      continueSendRef.current?.(continuePrompt(getLocale()));
                    }
                  : undefined
              }
              // Same for Run on a paid picture or clip (SR-167): the newest reply's card is the one that waits.
              onRunMedia={
                agentIdReady && mayOfferContinue(index, shown.length, message.role)
                  ? (requests) => {
                      if (runningRef.current) {
                        return;
                      }
                      continueSendRef.current?.(t("chat.media.runPrompt"), false, requests);
                    }
                  : undefined
              }
            />
          ))}
        {running || thinking || tools.length > 0 || streaming || sendFailed ? (
          <div data-testid="assistant-live">
            <ChatTurn
              role="assistant"
              live={{
                thinking,
                tools,
                streaming,
                running,
                thinkingEnabled: tierThinkingEnabled(tierId),
                failed: sendFailed,
                firstTurn: messages.every((message) => message.role !== "assistant"),
              }}
            />
          </div>
        ) : null}
        {canOfferRetry({ failed: sendFailed, retryText, messages }) ? (
          <div>
            <button
              type="button"
              className="btn"
              data-testid="chat-retry"
              onClick={() => continueSendRef.current?.(retryText ?? "", true)}
            >
              {t("chat.turn.retry")}
            </button>
          </div>
        ) : null}
        {fallback && !sendFailed ? <ChatModelFallbackNotice notice={fallback} /> : null}
      </div>
      {agentIdReady ? (
        <div className="chat-composer-ledge">
          {/* In a thread Nultron peeks over the composer and is the one status character; the empty
            Chat has the hero instead. Not in the chat-first shell (owner, 2026-10-09: the character
            must not overlap generated content): the thread scrolls behind this ledge, so there the
            character is the small head in the rail, where nothing scrolls under it. */}
          {empty || shell ? null : <BuddyStage kind="composer" mode="chat" size={COMPOSER_BUDDY_SIZE} />}
          <FolderSurface running={running} />
          <ChatComposer
            threadId={threadId}
            sessionKey={sessionKey}
            onEnsureThread={ensureThread}
            modalities={modalities.length > 0 ? modalities : ["text"]}
            tier={tierId}
            tiers={tiers}
            // In the chat-first shell the tier is chosen in the header, so the composer shows none.
            onTierChange={shell ? undefined : handleTierChange}
            placeholder={shell ? t("agents.composer.placeholder", { name: shell.name }) : undefined}
            onToolProgress={(event) => {
              // A worker's progress line belongs to the call of that tool that is still running.
              setTools((current) => {
                let index = -1;
                for (let i = current.length - 1; i >= 0; i -= 1) {
                  if (current[i]?.key === event.toolKey && current[i]?.status === "started") {
                    index = i;
                    break;
                  }
                }
                if (index < 0 || current[index]?.progress === event.label) {
                  return current;
                }
                const next = [...current];
                const target = next[index];
                if (!target) {
                  return current;
                }
                next[index] = { ...target, progress: event.label };
                return next;
              });
            }}
            draft={composerDraft}
            continueSendRef={continueSendRef}
            onDraftApplied={() => setComposerDraft(null)}
            onUserSend={(payload) => {
              pinRef.current = true;
              setError(null);
              setSendFailed(false);
              setRetryText(retryTextOf(payload));
              setRunning(true);
              rememberTier(tierId);
              setThinking("");
              setTools([]);
              setFallback(null);
              setStreaming("");
              const content =
                payload.parts && payload.parts.length > 0 ? payload.parts : [{ type: "text", text: payload.text }];
              setMessages((current) =>
                payload.retry ? current : [...current, { id: `local-${Date.now()}`, role: "user", content }],
              );
            }}
            onStarted={() => setRunning(true)}
            onDelta={(text) => setStreaming((current) => current + text)}
            onThinking={(text) => setThinking((current) => current + text)}
            onTool={(event) => {
              setTools((current) => {
                if (event.phase === "started") {
                  return [...current, { key: event.toolKey, status: "started", input: event.input }];
                }
                const next = [...current];
                let index = -1;
                for (let i = next.length - 1; i >= 0; i -= 1) {
                  if (next[i]?.key === event.toolKey && next[i]?.status === "started") {
                    index = i;
                    break;
                  }
                }
                const completed = {
                  key: event.toolKey,
                  status: "completed" as const,
                  input: index >= 0 ? next[index]?.input : event.input,
                  output: event.output,
                };
                if (index >= 0) {
                  next[index] = completed;
                  return next;
                }
                return [...next, completed];
              });
            }}
            onFailed={() => {
              setSendFailed(true);
              setRunning(false);
            }}
            onModelFallback={(event) => setFallback((held) => nextModelFallback(held, event))}
            onSettled={() => setRunning(false)}
            onComplete={async (run) => {
              notifyThreadsChanged();
              if (run.stale) {
                // A newer turn began before this one's tail ran, so its streaming text, tools and Running
                // state are not ours to reset. Its own end reloads the thread, this turn's reply included.
                // If it never reached the host nothing is live, and this turn's saved reply is reloaded now.
                if (!runningRef.current && run.showing && run.threadId && run.threadId === threadIdRef.current) {
                  await refreshMessages(run.threadId).catch(() => undefined);
                }
                return;
              }
              if (!run.showing) {
                // The owner opened another session while this run streamed, and the host saved the
                // reply. Show it only if the pane has come back to that thread since.
                if (run.threadId && run.threadId === threadIdRef.current) {
                  await refreshMessages(run.threadId).catch(() => undefined);
                }
                return;
              }
              const key = sessionEpochRef.current;
              const liveMedia = toolsRef.current.flatMap((tool) => collectToolMediaParts(tool.output));
              setStreaming("");
              setThinking("");
              setRunning(false);
              if (threadIdRef.current) {
                await refreshMessages(threadIdRef.current);
              }
              if (sessionEpochRef.current !== key) {
                // The owner moved on while the messages reloaded; this run's media is not theirs now.
                return;
              }
              setTools([]);
              if (liveMedia.length > 0) {
                setMessages((current) => {
                  const hasMedia = current.some(
                    (message) =>
                      message.role === "assistant" &&
                      Array.isArray(message.content) &&
                      message.content.some(
                        (part) =>
                          part &&
                          typeof part === "object" &&
                          ((part as { type?: unknown }).type === "image_url" ||
                            (part as { type?: unknown }).type === "video_url"),
                      ),
                  );
                  if (hasMedia) {
                    return current;
                  }
                  return [
                    ...current,
                    {
                      id: `local-media-${Date.now()}`,
                      role: "assistant",
                      content: liveMedia,
                    },
                  ];
                });
              }
            }}
          />
        </div>
      ) : error ? null : (
        <p className="mt-6 text-sm text-ink/50">{t("chat.starting")}</p>
      )}
      {agentIdReady && greeting ? <ChatIdeaChips onSuggest={setComposerDraft} /> : null}
    </main>
  );
}
