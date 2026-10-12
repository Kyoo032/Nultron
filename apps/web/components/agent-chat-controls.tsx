"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { ModeIcon, isModeIconName } from "@/components/mode-icons";
import { productMonogram } from "@/components/app-shell";
import { Link, useRouter } from "@/lib/nav";
import { t } from "@/lib/i18n";
import { useProductBrand, usesBundledMark } from "@/lib/product-brand";
import { RAIL_RECENT_THREADS, takeRecentThreads } from "@/lib/thread-groups";
import { useChatThreads, type ChatThread } from "@/lib/use-chat-threads";
import { virtualAgentHref, type VirtualAgentInfo } from "@/lib/virtual-agents";
import "@/components/agent-chat.css";

/**
 * The header of an agent's conversation in the chat-first shell (tester code, chat-first plan
 * track B1): who you are talking to, the model tier, and the three controls a conversation needs.
 * The session list that sat in the wide rail lives here, under Conversations, because the rail is
 * icons only.
 */

type AgentRef = Pick<VirtualAgentInfo, "id" | "generalist" | "agentId">;

/** The agent's face: the product mark for the generalist, its mode icon in its mode colour otherwise. */
export function AgentTile({ agent, size = 32 }: { agent: Pick<VirtualAgentInfo, "id" | "generalist">; size?: number }) {
  const brand = useProductBrand();
  if (agent.generalist) {
    return (
      <span className="agent-tile agent-tile-brand" style={{ width: size, height: size }} aria-hidden="true">
        {usesBundledMark(brand) ? (
          // The mark ships in two tuned sizes; the tile takes the one that fits it.
          <BrandMark size={size >= 32 ? 32 : 24} />
        ) : brand.logoSrc ? (
          <img src={brand.logoSrc} alt="" className="h-[62%] w-[62%] object-contain" />
        ) : (
          <span className="text-xs font-semibold">{productMonogram(brand.productName)}</span>
        )}
      </span>
    );
  }
  return (
    <span className="agent-tile" style={{ width: size, height: size }} data-mode={agent.id} aria-hidden="true">
      <ModeIcon name={isModeIconName(agent.id) ? agent.id : "documents"} size={Math.round(size * 0.5)} strokeWidth={2} />
    </span>
  );
}

type HeaderProps = {
  agent: Pick<VirtualAgentInfo, "id" | "generalist">;
  name: string;
  /** The model tier choice, drawn as a chip beside the name. */
  tier?: ReactNode;
  /** The quiet chips (context, usage, account). They give way first when the header is narrow. */
  chips?: ReactNode;
  /** New chat, Conversations, How it works. Always on screen. */
  controls?: ReactNode;
};

export function AgentChatHeader({ agent, name, tier, chips, controls }: HeaderProps) {
  return (
    <header className="agent-chat-header px-[var(--chat-gutter)]" data-testid="chat-header" data-agent={agent.id}>
      <div className="agent-chat-identity">
        <AgentTile agent={agent} />
        <h1 className="agent-chat-name" data-testid="agent-name">
          {name}
        </h1>
        {tier ? <div className="agent-chat-tier">{tier}</div> : null}
      </div>
      <div className="agent-chat-end">
        {chips ? (
          <div className="agent-chat-chips text-xs" data-testid="chat-header-controls">
            {chips}
          </div>
        ) : null}
        {controls ? <div className="agent-chat-controls">{controls}</div> : null}
      </div>
    </header>
  );
}

function IconButtonShape({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function AgentNewChatLink({ agent }: { agent: AgentRef }) {
  const label = t("agents.header.newChat");
  return (
    <Link
      href={virtualAgentHref(agent.id)}
      className="agent-chat-btn"
      aria-label={label}
      title={label}
      data-testid="new-chat-link"
    >
      <IconButtonShape>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      </IconButtonShape>
    </Link>
  );
}

export function AgentHarnessToggle({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  const label = t("agents.header.harness", { name });
  return (
    <button
      type="button"
      className="agent-chat-btn"
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={onToggle}
      data-testid="agent-harness-toggle"
    >
      <IconButtonShape>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M15 4v16" />
      </IconButtonShape>
    </button>
  );
}

type HistoryProps = {
  agent: AgentRef;
  name: string;
  /** The conversation on screen, so its row is marked. */
  activeThreadId?: string | null;
};

/** The list itself, apart from its popover, so it can be drawn and tested without a click. */
export function AgentHistoryList({
  agent,
  threads,
  loaded,
  error,
  activeThreadId,
  deletingId,
  onDelete,
  onPick,
}: {
  agent: AgentRef;
  threads: readonly ChatThread[];
  loaded: boolean;
  error: string | null;
  activeThreadId?: string | null;
  deletingId?: string | null;
  onDelete?: (thread: ChatThread) => void;
  onPick?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? threads : takeRecentThreads([...threads], RAIL_RECENT_THREADS * 2);
  return (
    <div className="agent-history-list" data-testid="rail-thread-list">
      {error ? (
        <p className="agent-history-note" role="alert" data-testid="rail-thread-error">
          {error}
        </p>
      ) : null}
      {loaded && threads.length === 0 && !error ? (
        <p className="agent-history-note" data-testid="agent-history-empty">
          {t("agents.header.historyEmpty")}
        </p>
      ) : null}
      {shown.map((thread) => {
        const active = activeThreadId === thread.id;
        return (
          <div key={thread.id} className="agent-history-row">
            <Link
              href={virtualAgentHref(agent.id, thread.id)}
              className="agent-history-item"
              aria-current={active ? "true" : undefined}
              title={thread.title}
              onClick={onPick}
              data-testid="thread-item"
            >
              <span className="truncate">{thread.title}</span>
            </Link>
            {onDelete ? (
              <button
                type="button"
                className="agent-history-delete"
                onClick={() => onDelete(thread)}
                disabled={deletingId === thread.id}
                aria-label={t("chat.deleteAria", { title: thread.title })}
                title={t("chat.deleteSession")}
                data-testid="thread-delete"
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
      {threads.length > shown.length || expanded ? (
        <button
          type="button"
          className="agent-history-more"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          data-testid="threads-see-all"
        >
          {expanded ? t("agents.header.seeFewer") : t("agents.header.seeAll")}
        </button>
      ) : null}
    </div>
  );
}

/** Conversations with this agent, in a panel under the header button. */
export function AgentHistoryButton({ agent, name, activeThreadId }: HistoryProps) {
  const router = useRouter();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { threads, error, deletingId, removeThread, loaded } = useChatThreads(
    agent.generalist ? { scope: "chat" } : { scope: "agent", agentId: agent.agentId ?? undefined },
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointer(event: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function onDelete(thread: ChatThread) {
    const removed = await removeThread(thread);
    // The pane keeps a deleted thread alive in its own ref, so leave it.
    if (removed && activeThreadId === thread.id) {
      router.push(virtualAgentHref(agent.id));
    }
  }

  const label = t("agents.header.history");
  return (
    <div ref={wrapRef} className="agent-history">
      <button
        ref={buttonRef}
        type="button"
        className="agent-chat-btn"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
        data-testid="agent-history-toggle"
      >
        <IconButtonShape>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </IconButtonShape>
      </button>
      {open ? (
        <div
          id={panelId}
          className="agent-history-panel"
          role="dialog"
          aria-label={t("agents.header.historyAria", { name })}
          data-testid="agent-history"
        >
          <p className="agent-history-title">{label}</p>
          <AgentHistoryList
            agent={agent}
            threads={threads}
            loaded={loaded}
            error={error}
            activeThreadId={activeThreadId}
            deletingId={deletingId}
            onDelete={(thread) => void onDelete(thread)}
            onPick={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
